// src/actions/toggle-project.ts

import { action, SendToPluginEvent, WillAppearEvent, JsonValue, SingletonAction, streamDeck, KeyDownEvent } from "@elgato/streamdeck";
import { ApiClient } from "../api/client";
import { Project, TimeEntry } from "../api/types";
import { ActionSettings } from "../settings";

const STOPPED_STATE = 0;
const RUNNING_STATE = 1;

type PluginContext = {
    organizationId: string;
    memberId: string;
    triggerPoll: () => void;
    triggerRefresh: () => Promise<void>; // Add the refresh function
};

@action({ UUID: "com.benjamin-benavides.solidtime-deck.toggle-project" })
export class ToggleProjectAction extends SingletonAction<ActionSettings> {
    // This will hold the shared ApiClient instance.
    private apiClient?: ApiClient;
    private projects: Project[] = [];
    private organizationId?: string;
    private memberId?: string;
    private triggerPoll?: () => void;
    private triggerRefresh?: () => Promise<void>;

    /**
     * This public method allows the main plugin to provide the ApiClient.
     */
    public setApiClient(apiClient: ApiClient): void {
        this.apiClient = apiClient;
        console.log("ToggleProjectAction now has an API client.");
        // We can now update all visible buttons to show they are ready.
    }

    /**
     * Called by the plugin to provide the fetched list of projects.
     */
    public setProjects(projects: Project[]): void {
        this.projects = projects;
    }

    public setContext(context: PluginContext): void {
        this.organizationId = context.organizationId;
        this.memberId = context.memberId;
        this.triggerPoll = context.triggerPoll;
        this.triggerRefresh = context.triggerRefresh;
    }

    public updateAllButtonStates(activeEntry: TimeEntry | undefined): void {
        // Iterate over every visible instance of this action.
        for (const action of this.actions) {
            if (!action.isKey()) continue;

            // Get the projectId assigned to this specific button.
            const settings = action.getSettings();

            settings.then(settings => {
                if (!settings.projectId) {
                    // If no project is assigned, ensure it's in the stopped state.
                    action.setState(STOPPED_STATE);
                    return;
                }
    
                // Check if the active timer's project matches this button's project.
                if (activeEntry && activeEntry.project_id === settings.projectId) {
                    action.setState(RUNNING_STATE);
                } else {
                    action.setState(STOPPED_STATE);
                }
            })
        }
    }

    // --- Stream Deck Lifecycle Events ---

        /**
     * This is the core logic that runs when a user presses a key.
     */
    override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
        // 1. Guard against unconfigured plugin or button.
        if (!this.apiClient || !this.organizationId || !this.memberId) {
            streamDeck.logger.warn("Key pressed before plugin was configured.");
            ev.action.showAlert();
            return;
        }

        const { projectId } = ev.payload.settings;
        if (!projectId) {
            streamDeck.logger.info("Key pressed on a button with no project assigned.");
            return;
        }

        try {
            // 3. Fetch the latest ground truth from the API.
            let activeEntry: TimeEntry | undefined;
            try {
                const response = await this.apiClient.getActiveTimeEntry();
                activeEntry = response.data;
            } catch (error) {
                // A 404 error is expected if nothing is running.
                activeEntry = undefined;
            }

            const isThisProjectRunning = activeEntry?.project_id === projectId;
            const now = new Date().toISOString();
            const nowWithoutMilliseconds = now.split('.')[0] + 'Z';

            // 4. Execute the toggle logic based on the real state.
            if (isThisProjectRunning) {
                // The pressed button's project is running, so stop it.
                await this.apiClient.stopTimeEntry(this.organizationId, activeEntry!.id, { end: nowWithoutMilliseconds });
            } else {
                // A different project might be running, or none at all.
                if (activeEntry) {
                    // First, stop the other running project.
                    await this.apiClient.stopTimeEntry(this.organizationId, activeEntry.id, { end: nowWithoutMilliseconds });
                }
                // Then, start the new project.
                await this.apiClient.startTimeEntry(this.organizationId, {
                    member_id: this.memberId,
                    project_id: projectId,
                    start: nowWithoutMilliseconds,
                    billable: true // Defaulting to true as per spec
                });
            }
        } catch (error) {
            streamDeck.logger.error('Failed to toggle timer:', error);
            ev.action.showAlert();
        } finally {
            // 5. Trigger an immediate poll to sync all buttons with the new true state.
            this.triggerPoll?.();
        }
    }

    /**
     * Called when a button for this action appears on the Stream Deck.
     * We use this to set its initial state.
     */
    override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
        if (!ev.action.isKey()) return;

        // This is a placeholder for now. The polling mechanism will soon take over.
        // For now, we just ensure it starts in the "Not Running" state.
        ev.action.setState(STOPPED_STATE);
    }

    /**
     * Listens for messages from the Property Inspector UI.
     */
    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ActionSettings>): Promise<void> {
        // Check if the payload has the structure we expect for a datasource request
        if (!(ev.payload instanceof Object) || !("event" in ev.payload) || ev.payload.event !== "getProjects") {
            return;
        }

        // If this is a refresh request, await the data refresh from the main plugin.
        if (this.triggerRefresh && "isRefresh" in ev.payload && ev.payload.isRefresh === true) {
            streamDeck.logger.info("Refresh triggered from UI. Fetching new project list...");
            await this.triggerRefresh();
        }

        // Format the (potentially updated) project list for the dropdown.
        const projectItems = this.projects.map(project => ({
            label: project.name,
            value: project.id
        }));

        // Send the list back to the UI.
        streamDeck.ui.current?.sendToPropertyInspector({
            event: "getProjects",
            items: projectItems
        });
    }
}