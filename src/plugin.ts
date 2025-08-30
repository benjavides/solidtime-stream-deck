const API_URL = "https://time.benjavides.com/api";
const API_TOKEN = "";

import streamDeck, { DeviceDidConnectEvent, DidReceiveGlobalSettingsEvent, LogLevel } from "@elgato/streamdeck";
import { ApiClient } from "./api/client";
import { ToggleProjectAction } from "./actions/toggle-project";
import { GlobalSettings } from "./settings";
import { Project, TimeEntry } from "./api/types";

// --- Setup ---
streamDeck.logger.setLevel(LogLevel.TRACE);

// --- Plugin-wide State Management ---
// These variables hold the shared state for the entire plugin.
let apiClient: ApiClient | undefined;
let organizationId: string | undefined;
let projects: Project[] = [];
let activeTimeEntry: TimeEntry | undefined;

// --- Action Registration ---
// We create a single instance of our action class to be managed by the plugin.
const toggleAction = new ToggleProjectAction();
streamDeck.actions.registerAction(toggleAction);

// --- Core Logic Functions ---

/**
 * Fetches the initial data required for the plugin to operate using the new dedicated client methods.
 * @param client The ApiClient instance to use for requests.
 */
async function fetchInitialData(client: ApiClient): Promise<void> {
    streamDeck.logger.info("Fetching initial data from Solidtime API...");
    try {
        // 1. Get memberships to find the user's organizationId
        const membershipsResponse = await client.getMemberships();
        if (membershipsResponse.data && membershipsResponse.data.length > 0) {
            // Use the first organization found. The 'organization' object is nested inside the membership.
            organizationId = membershipsResponse.data[0].organization.id;
            streamDeck.logger.info(`Found Organization ID: ${organizationId}`);
        } else {
            streamDeck.logger.warn("User does not appear to be part of any organization.");
            return; // Stop here if we don't have an organization
        }

        // 2. Get the list of projects for that organization
        const projectsResponse = await client.getActiveProjects(organizationId);
        projects = projectsResponse.data || [];
        toggleAction.setProjects(projects);
        streamDeck.logger.info(`Fetched ${projects.length} active projects.`);

        // 3. Get the currently active time entry, if one exists
        try {
            const activeEntryResponse = await client.getActiveTimeEntry();
            activeTimeEntry = activeEntryResponse.data;
            if (activeTimeEntry) {
                streamDeck.logger.info(`An active time entry was found for project ID: ${activeTimeEntry.project_id}`);
            }
        } catch (error) {
            // A 404 Not Found error is expected if no timer is running. We can safely ignore it.
            activeTimeEntry = undefined;
            streamDeck.logger.info("No active time entry found.");
        }

    } catch (error) {
        streamDeck.logger.error("An error occurred while fetching initial data.");
        console.error(error);
    }
}


/**
 * Initializes (or re-initializes) the ApiClient when settings are provided.
 * @param settings The global settings from the Stream Deck store.
 */
function initializeApiClient(settings: GlobalSettings): void {
    if (settings.solidtimeBaseUrl && settings.accessToken) {
        streamDeck.logger.info("Valid global settings found, initializing API client.");
        apiClient = new ApiClient({
            baseUrl: settings.solidtimeBaseUrl,
            accessToken: settings.accessToken,
        });

        // Provide the newly created client to our action instance and fetch data.
        toggleAction.setApiClient(apiClient);
        fetchInitialData(apiClient);

    } else {
        streamDeck.logger.warn("Global settings are incomplete, API client not initialized.");
        apiClient = undefined;
    }
}

// --- Event Listeners ---

// 1. Listen for when the user saves global settings from the Property Inspector.
streamDeck.settings.onDidReceiveGlobalSettings((ev: DidReceiveGlobalSettingsEvent<GlobalSettings>) => {
    streamDeck.logger.info("Global settings were updated by the UI.");
    initializeApiClient(ev.settings);
});

// 2. Listen for when a device connects to check for pre-existing settings.
streamDeck.devices.onDeviceDidConnect(async (ev: DeviceDidConnectEvent) => {
    streamDeck.logger.info(`Device ${ev.device.name} connected.`);
    streamDeck.logger.info("Checking for existing global settings...");

    const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
    initializeApiClient(settings);
    // try {
    //     // Create an instance of our ApiClient.
    //     const apiClient = new ApiClient({
    //         baseUrl: API_URL,
    //         accessToken: API_TOKEN,
    //     });

    //     // Call the 'get' method for the memberships endpoint.
    //     const memberships = await apiClient.get('/v1/users/me/memberships');

    //     // Log the successful result to the debug console.
    //     streamDeck.logger.info('✅ API Test Successful! Received data:');
    //     console.log(memberships);

    // } catch (error) {
    //     // If anything goes wrong, log the error.
    //     streamDeck.logger.error('❌ API Test Failed.');
    //     console.error(error);
    // }
});

// --- Plugin Entry Point ---
// Finally, connect to the Stream Deck to start the plugin.
streamDeck.connect();
