// src/actions/toggle-project.ts

import { action, SingletonAction } from "@elgato/streamdeck";
import { ApiClient } from "../api/client";
import { ActionSettings } from "../settings";

@action({ UUID: "com.benjamin-benavides.solidtime-deck.toggle-project" })
export class ToggleProjectAction extends SingletonAction<ActionSettings> {
    // This will hold the shared ApiClient instance.
    private apiClient?: ApiClient;

    /**
     * This public method allows the main plugin to provide the ApiClient.
     */
    public setApiClient(apiClient: ApiClient): void {
        this.apiClient = apiClient;
        console.log("ToggleProjectAction now has an API client.");
        // We can now update all visible buttons to show they are ready.
    }

    // We will add onWillAppear, onKeyDown, etc. here later.
    // For example, onKeyDown would look something like this:
    /*
    onKeyDown(ev: KeyDownEvent<ActionSettings>): void {
        if (this.apiClient) {
            // Use this.apiClient to stop/start timers...
            console.log(`Key pressed for project: ${ev.payload.settings.projectId}`);
        } else {
            // Show an error on the key because the plugin is not configured.
            ev.action.showAlert();
        }
    }
    */
}