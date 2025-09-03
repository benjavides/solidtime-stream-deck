import { action, SendToPluginEvent, WillAppearEvent, WillDisappearEvent, JsonValue, SingletonAction, streamDeck, KeyDownEvent, DidReceiveSettingsEvent, KeyAction } from "@elgato/streamdeck";
import { ApiClient } from "../api/client";
import { Project, TimeEntry, Membership, Tag } from "../api/types";
import { ActionSettings } from "../settings";

// Define constants for the two states from the manifest for readability.
const STOPPED_STATE = 0;
const RUNNING_STATE = 1;

// Define the shape of the context object passed from the main plugin file.
type PluginContext = {
    triggerPoll: () => void;
    triggerRefresh: () => Promise<void>;
    getActiveTimeEntry: () => TimeEntry | undefined;
    getProjectsForOrg: (orgId: string, opts?: { refresh?: boolean }) => Promise<Project[]>;
    getMemberIdForOrg: (orgId: string) => string | undefined;
    getTagsForOrg: (orgId: string, opts?: { refresh?: boolean }) => Promise<Tag[]>;
};

/**
 * Formats a duration in seconds into a human-readable string (e.g., "1d 2h 5m" or "55s").
 * - Shows only seconds for the first minute for immediate feedback.
 * - Omits seconds after the first minute for a cleaner display.
 * @param totalSeconds The total seconds to format.
 * @returns The formatted time string.
 */
function formatElapsedTime(totalSeconds: number): string {
    if (totalSeconds < 0) totalSeconds = 0;

    if (totalSeconds < 60) {
        return `${Math.floor(totalSeconds)}s`;
    }

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    if (parts.length === 0) {
        return `${Math.floor(totalSeconds / 60)}m`;
    }

    return parts.join(' ');
}


@action({ UUID: "com.benjamin-benavides.solidtime-deck.toggle-project" })
export class ToggleProjectAction extends SingletonAction<ActionSettings> {
    // Properties to hold the shared API client and data from the main plugin.
    private apiClient?: ApiClient;
    private memberships: Membership[] = [];
    private triggerPoll?: () => void;
    private triggerRefresh?: () => Promise<void>;
    private getActiveTimeEntry?: () => TimeEntry | undefined;
    private getProjectsForOrg?: (orgId: string, opts?: { refresh?: boolean }) => Promise<Project[]>;
    private getMemberIdForOrg?: (orgId: string) => string | undefined;
    private getTagsForOrg?: (orgId: string, opts?: { refresh?: boolean }) => Promise<Tag[]>;

    // A cache to store the last title set for each button, preventing unnecessary updates and flickering.
    private lastTitles: Map<string, string> = new Map();
    private lastSettingsByActionId: Map<string, ActionSettings> = new Map();

    // --- Public Methods for Plugin Control ---

    public setApiClient(apiClient: ApiClient): void {
        this.apiClient = apiClient;
    }

    public setMemberships(memberships: Membership[]): void {
        this.memberships = memberships;
    }

    public setContext(context: PluginContext): void {
        this.triggerPoll = context.triggerPoll;
        this.triggerRefresh = context.triggerRefresh;
        this.getActiveTimeEntry = context.getActiveTimeEntry;
        this.getProjectsForOrg = context.getProjectsForOrg;
        this.getMemberIdForOrg = context.getMemberIdForOrg;
        this.getTagsForOrg = context.getTagsForOrg;
    }

    // --- Title and State Update Logic ---

    /**
     * Calculates and sets the title for a given action based on its settings and the current running timer.
     */
    private async updateTitle(action: KeyAction<ActionSettings>, settings: ActionSettings, activeEntry: TimeEntry | undefined): Promise<void> {
        const { projectId, organizationId, showElapsedTime = true, titleOverride } = settings;

        if (!projectId) {
            this.conditionallySetTitle(action, '');
            return;
        }

        const isRunning = activeEntry && activeEntry.project_id === projectId;

        let baseTitle = titleOverride || '';
        if (!baseTitle) {
            let projectName = '';
            if (organizationId && this.getProjectsForOrg) {
                try {
                    const projects = await this.getProjectsForOrg(organizationId);
                    const project = projects.find(p => p.id === projectId);
                    projectName = project ? project.name : '';
                } catch {
                    projectName = '';
                }
            }
            baseTitle = projectName;
        }

        let finalTitle = baseTitle;
        if (isRunning && showElapsedTime) {
            const startTime = new Date(activeEntry.start);
            const now = new Date();
            const elapsedSeconds = (now.getTime() - startTime.getTime()) / 1000;
            const elapsedTimeString = formatElapsedTime(elapsedSeconds);
            finalTitle = `${baseTitle}\n${elapsedTimeString}`;
        }
        
        this.conditionallySetTitle(action, finalTitle);
    }

    /**
     * A helper method that only calls `action.setTitle()` if the new title is different from the cached one, preventing flickering.
     */
    private conditionallySetTitle(action: KeyAction<ActionSettings>, newTitle: string): void {
        const lastTitle = this.lastTitles.get(action.id);
        
        if (lastTitle !== newTitle) {
            action.setTitle(newTitle);
            this.lastTitles.set(action.id, newTitle);
        }
    }

    /**
     * The main refresh function called by the polling timer. It iterates through all visible buttons
     * and updates their state and title to match the latest data from the API.
     */
    public async updateAllButtonStates(activeEntry: TimeEntry | undefined): Promise<void> {
        // Iterate sequentially using `for...of` with `await` to prevent race conditions.
        for (const action of this.actions) {
            if (!action.isKey()) continue;

            const settings = await action.getSettings();

            if (!settings.projectId) {
                action.setState(STOPPED_STATE);
                this.conditionallySetTitle(action, '');
                continue;
            }

            const isRunning = activeEntry && activeEntry.project_id === settings.projectId;
            action.setState(isRunning ? RUNNING_STATE : STOPPED_STATE);
            
            await this.updateTitle(action, settings, activeEntry);
        }
    }
    
    // --- Stream Deck Lifecycle and Event Handlers ---

    /**
     * Called by the SDK automatically when a user changes a setting for a button in the UI.
     * This allows for instant visual feedback without waiting for the next poll.
     */
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>): Promise<void> {
        if (!ev.action.isKey()) return;

        const newSettings = ev.payload.settings || {};
        
        const prev = this.lastSettingsByActionId.get(ev.action.id) || {};

        // Normalize tagIds to string[]
        const normalizeTagIds = (v: any): string[] | undefined => {
            if (Array.isArray(v)) return v.filter(Boolean).map(String);
            if (v == null) return undefined;
            // handle single value
            if (typeof v === 'string') return v ? [v] : [];
            return undefined;
        };
        const prevTagIds = normalizeTagIds((prev as any).tagIds) || [];
        const newTagIds = normalizeTagIds((newSettings as any).tagIds) || [];
        const prevDescription = typeof (prev as any).description === 'string' ? (prev as any).description : '';
        const newDescription = typeof (newSettings as any).description === 'string' ? (newSettings as any).description : '';

        // If organization changed (including first set or clear), clear tagIds to avoid cross-org tags lingering
        const prevOrg = (prev.organizationId ?? '');
        const newOrg = (newSettings.organizationId ?? '');
        const orgChanged = prevOrg !== newOrg;
        if (orgChanged){
            streamDeck.logger.info("Organization changed from {prevOrg} to {newOrg}", { prevOrg, newOrg });
            if (newTagIds.length > 0) {
                try {
                    await ev.action.setSettings({ ...newSettings, tagIds: [] });
                } catch {}
            }
            try {
                // Notify the specific PI for this action context
                streamDeck.ui.current?.sendToPropertyInspector({
                    event: "organizationChanged",
                    organizationId: newOrg || ""
                });
              } catch (err) {
                streamDeck.logger.error("Failed to send organizationChanged to PI", err);
              }
        }

        // If tags changed and the corresponding entry is running for same org+project, patch tags
        const tagsChanged = JSON.stringify(prevTagIds.slice().sort()) !== JSON.stringify(newTagIds.slice().sort());
        const descriptionChanged = prevDescription !== newDescription;
        if ((tagsChanged || descriptionChanged) && this.apiClient) {
            const activeEntry = this.getActiveTimeEntry ? this.getActiveTimeEntry() : undefined;
            if (
                activeEntry &&
                newSettings.projectId &&
                newSettings.organizationId &&
                activeEntry.project_id === newSettings.projectId &&
                activeEntry.organization_id === newSettings.organizationId
            ) {
                try {
                    // Prepare changes without logging sensitive payload
                    const changes: any = {};
                    if (tagsChanged) changes.tags = newTagIds;
                    if (descriptionChanged) changes.description = (newDescription.trim() === '' ? null : newDescription);
                    if (Object.keys(changes).length > 0) {
                        await this.apiClient.patchTimeEntries(newSettings.organizationId, [activeEntry.id], changes);
                    }
                } catch (err) {
                    streamDeck.logger.error('Failed to patch tags for active entry.');
                    // Non-blocking PI error message
                    streamDeck.ui.current?.sendToPropertyInspector({
                        event: 'tagsPatchError',
                        message: 'Failed to update tags on the running entry.'
                    });
                }
            }
        }

        // Cache latest settings for next diff and update title
        this.lastSettingsByActionId.set(ev.action.id, { ...newSettings, tagIds: newTagIds });
        const activeEntry = this.getActiveTimeEntry ? this.getActiveTimeEntry() : undefined;
        await this.updateTitle(ev.action, newSettings, activeEntry);
    }
    
    /**
     * The core logic that runs when a user presses a key.
     */
    override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
        if (!this.apiClient) {
            streamDeck.logger.warn("Key pressed before plugin was configured.");
            ev.action.showAlert();
            return;
        }

        const { projectId, organizationId, billable = true } = ev.payload.settings;
        if (!projectId) {
            streamDeck.logger.info("Key pressed on a button with no project assigned.");
            return;
        }
        if (!organizationId) {
            streamDeck.logger.warn("No organization selected for this button.");
            ev.action.showAlert();
            return;
        }

        const memberId = this.getMemberIdForOrg ? this.getMemberIdForOrg(organizationId) : undefined;
        if (!memberId) {
            streamDeck.logger.error(`No membership found for org ${organizationId}.`);
            ev.action.showAlert();
            return;
        }

        try {
            let activeEntry: TimeEntry | undefined;
            try {
                const response = await this.apiClient.getActiveTimeEntry();
                activeEntry = response.data;
            } catch (error) {
                activeEntry = undefined;
            }

            const isThisProjectRunning = activeEntry?.project_id === projectId;
            const now = new Date().toISOString();
            const nowWithoutMilliseconds = now.split('.')[0] + 'Z';

            if (isThisProjectRunning) {
                // Stop in the org where the active entry is running (could be different)
                await this.apiClient.stopTimeEntry(activeEntry!.organization_id, activeEntry!.id, { end: nowWithoutMilliseconds });
            } else {
                if (activeEntry) {
                    await this.apiClient.stopTimeEntry(activeEntry.organization_id, activeEntry.id, { end: nowWithoutMilliseconds });
                }
                
                await this.apiClient.startTimeEntry(organizationId, {
                    member_id: memberId,
                    project_id: projectId,
                    start: nowWithoutMilliseconds,
                    billable: billable,
                    // include selected tag IDs on start; avoid logging sensitive details elsewhere
                    tags: Array.isArray(ev.payload.settings.tagIds) ? ev.payload.settings.tagIds : [],
                    // include description if provided
                    ...(typeof ev.payload.settings.description === 'string' && ev.payload.settings.description.trim() !== ''
                        ? { description: ev.payload.settings.description }
                        : {})
                });
            }
        } catch (error) {
            streamDeck.logger.error('Failed to toggle timer:', error);
            ev.action.showAlert();
        } finally {
            // Trigger an immediate poll to sync all buttons with the new true state.
            this.triggerPoll?.();
        }
    }

    override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
        if (!ev.action.isKey()) return;
        ev.action.setState(STOPPED_STATE);
    }
    
    /**
     * Cleans up the title cache when a button disappears to prevent memory leaks.
     */
    override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
        this.lastTitles.delete(ev.action.id);
    }

    /**
     * Listens for messages from the Property Inspector UI, primarily to handle the project list datasource request.
     */
    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ActionSettings>): Promise<void> {
        if (!(ev.payload instanceof Object) || !("event" in ev.payload)) {
            return;
        }

        // Handle the request for the organization list
        if (ev.payload.event === "getOrganizations") {
            streamDeck.logger.info("UI is requesting the list of organizations."); // Your requested log.

            // If this is a refresh, re-fetch all the initial data.
            if (this.triggerRefresh && "isRefresh" in ev.payload && ev.payload.isRefresh === true) {
                streamDeck.logger.info("Refresh triggered for organizations. Fetching new data...");
                await this.triggerRefresh();
            }

            const organizationItems = this.memberships.map(m => ({
                label: m.organization.name,
                value: m.organization.id
            }));
            streamDeck.ui.current?.sendToPropertyInspector({
                event: "getOrganizations",
                items: organizationItems
            });
            return;
        }

        // Handle the request for the project list
        if (ev.payload.event === "getProjects") {
            const settings = await ev.action.getSettings();
            const orgId = settings?.organizationId;
            const isRefresh = "isRefresh" in ev.payload && (ev.payload as any).isRefresh === true;

            if (!orgId || !this.getProjectsForOrg) {
                streamDeck.ui.current?.sendToPropertyInspector({ event: "getProjects", items: [] });
                return;
            }

            if (this.triggerRefresh && isRefresh) {
                // Forcing org projects refresh only
                await this.getProjectsForOrg(orgId, { refresh: true });
            }

            const projects = await this.getProjectsForOrg(orgId);
            const projectItems = projects.map(project => ({ label: project.name, value: project.id }));
            streamDeck.ui.current?.sendToPropertyInspector({ event: "getProjects", items: projectItems });
        }

        // Handle the request for the tags list
        if (ev.payload.event === "getTags") {
            const settings = await ev.action.getSettings();
            const orgId = settings?.organizationId;
            const isRefresh = "isRefresh" in ev.payload && (ev.payload as any).isRefresh === true;

            if (!orgId || !this.getTagsForOrg) {
                streamDeck.ui.current?.sendToPropertyInspector({ event: "getTags", items: [] });
                return;
            }

            if (isRefresh) {
                await this.getTagsForOrg(orgId, { refresh: true });
            }

            const tags = await this.getTagsForOrg(orgId);
            const tagItems = tags.map((tag: Tag) => ({ label: tag.name, value: tag.id }));
            streamDeck.ui.current?.sendToPropertyInspector({ event: "getTags", items: tagItems });
        }
    }
}
