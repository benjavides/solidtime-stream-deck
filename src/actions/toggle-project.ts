// src/actions/toggle-project.ts

import { action, SendToPluginEvent, JsonValue, SingletonAction, streamDeck } from "@elgato/streamdeck";
import { ApiClient } from "../api/client";
import { Project } from "../api/types";
import { ActionSettings } from "../settings";

@action({ UUID: "com.benjamin-benavides.solidtime-deck.toggle-project" })
export class ToggleProjectAction extends SingletonAction<ActionSettings> {
    // This will hold the shared ApiClient instance.
    private apiClient?: ApiClient;
    private projects: Project[] = [];

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

    /**
     * Listens for messages from the Property Inspector UI.
     */
    override onSendToPlugin(ev: SendToPluginEvent<JsonValue, ActionSettings>): void {
        // Check if the UI is requesting the list of projects.
        if (ev.payload instanceof Object && "event" in ev.payload && ev.payload.event === "getProjects") {
            
            // Format the projects array into the { label, value } format required by sdpi-select.
            const projectItems = this.projects.map(project => {
                return {
                    label: project.name,
                    value: project.id
                };
            });

            // Send the formatted list back to the property inspector.
            streamDeck.ui.current?.sendToPropertyInspector({
                event: "getProjects",
                items: projectItems
            });
        }
    }
}