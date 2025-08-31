import { action, SendToPluginEvent, WillAppearEvent, WillDisappearEvent, JsonValue, SingletonAction, streamDeck, KeyDownEvent, DidReceiveSettingsEvent, KeyAction } from "@elgato/streamdeck";
import { ApiClient } from "../api/client";
import { Project, TimeEntry } from "../api/types";
import { ActionSettings } from "../settings";

// Define constants for the two states from the manifest for readability.
const STOPPED_STATE = 0;
const RUNNING_STATE = 1;

// Define the shape of the context object passed from the main plugin file.
type PluginContext = {
    organizationId: string;
    memberId: string;
    triggerPoll: () => void;
    triggerRefresh: () => Promise<void>;
    getActiveTimeEntry: () => TimeEntry | undefined;
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
    private projects: Project[] = [];
    private organizationId?: string;
    private memberId?: string;
    private triggerPoll?: () => void;
    private triggerRefresh?: () => Promise<void>;
    private getActiveTimeEntry?: () => TimeEntry | undefined;

    // A cache to store the last title set for each button, preventing unnecessary updates and flickering.
    private lastTitles: Map<string, string> = new Map();

    // --- Public Methods for Plugin Control ---

    public setApiClient(apiClient: ApiClient): void {
        this.apiClient = apiClient;
    }

    public setProjects(projects: Project[]): void {
        this.projects = projects;
    }

    public setContext(context: PluginContext): void {
        this.organizationId = context.organizationId;
        this.memberId = context.memberId;
        this.triggerPoll = context.triggerPoll;
        this.triggerRefresh = context.triggerRefresh;
        this.getActiveTimeEntry = context.getActiveTimeEntry;
    }

    // --- Title and State Update Logic ---

    /**
     * Calculates and sets the title for a given action based on its settings and the current running timer.
     */
    private async updateTitle(action: KeyAction<ActionSettings>, settings: ActionSettings, activeEntry: TimeEntry | undefined): Promise<void> {
        const { projectId, showElapsedTime = true, titleOverride } = settings;

        if (!projectId) {
            this.conditionallySetTitle(action, '');
            return;
        }

        const isRunning = activeEntry && activeEntry.project_id === projectId;

        let baseTitle = titleOverride || '';
        if (!baseTitle) {
            const project = this.projects.find(p => p.id === projectId);
            baseTitle = project ? project.name : '';
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
        const activeEntry = this.getActiveTimeEntry ? this.getActiveTimeEntry() : undefined;
        await this.updateTitle(ev.action, ev.payload.settings, activeEntry);
    }
    
    /**
     * The core logic that runs when a user presses a key.
     */
    override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
        if (!this.apiClient || !this.organizationId || !this.memberId) {
            streamDeck.logger.warn("Key pressed before plugin was configured.");
            ev.action.showAlert();
            return;
        }

        const { projectId, billable = true } = ev.payload.settings;
        if (!projectId) {
            streamDeck.logger.info("Key pressed on a button with no project assigned.");
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
                await this.apiClient.stopTimeEntry(this.organizationId, activeEntry!.id, { end: nowWithoutMilliseconds });
            } else {
                if (activeEntry) {
                    await this.apiClient.stopTimeEntry(this.organizationId, activeEntry.id, { end: nowWithoutMilliseconds });
                }
                
                await this.apiClient.startTimeEntry(this.organizationId, {
                    member_id: this.memberId,
                    project_id: projectId,
                    start: nowWithoutMilliseconds,
                    billable: billable
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
        if (!(ev.payload instanceof Object) || !("event" in ev.payload) || ev.payload.event !== "getProjects") {
            return;
        }

        if (this.triggerRefresh && "isRefresh" in ev.payload && ev.payload.isRefresh === true) {
            streamDeck.logger.info("Refresh triggered from UI. Fetching new project list...");
            await this.triggerRefresh();
        }

        const projectItems = this.projects.map(project => ({
            label: project.name,
            value: project.id
        }));

        streamDeck.ui.current?.sendToPropertyInspector({
            event: "getProjects",
            items: projectItems
        });
    }
}