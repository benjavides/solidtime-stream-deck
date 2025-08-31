const API_URL = "https://time.benjavides.com/api";
const API_TOKEN = "";

import streamDeck, { DeviceDidConnectEvent, DidReceiveGlobalSettingsEvent, LogLevel } from "@elgato/streamdeck";
import { ApiClient } from "./api/client";
import { ToggleProjectAction } from "./actions/toggle-project";
import { GlobalSettings } from "./settings";
import { Project, TimeEntry } from "./api/types";

// --- Setup ---
streamDeck.logger.setLevel(LogLevel.DEBUG);

// --- Plugin-wide State Management ---
// These variables hold the shared state for the entire plugin.
let apiClient: ApiClient | undefined;
let organizationId: string | undefined;
let memberId: string | undefined;
let projects: Project[] = [];
let activeTimeEntry: TimeEntry | undefined;
let pollingInterval: NodeJS.Timeout | undefined;

// --- Action Registration ---
// We create a single instance of our action class to be managed by the plugin.
const toggleAction = new ToggleProjectAction();
streamDeck.actions.registerAction(toggleAction);

// --- Core Logic Functions ---

async function pollActiveTimer(): Promise<void> {
    if (!apiClient) return;

    try {
        const activeEntryResponse = await apiClient.getActiveTimeEntry();
        activeTimeEntry = activeEntryResponse.data;
    } catch (error) {
        activeTimeEntry = undefined;
    }

    toggleAction.updateAllButtonStates(activeTimeEntry);
}

/**
 * Fetches the initial data required for the plugin to operate using the new dedicated client methods.
 * @param client The ApiClient instance to use for requests.
 */
async function fetchInitialData(client: ApiClient): Promise<void> {
    streamDeck.logger.info("Fetching initial data from Solidtime API...");
    try {
        // 1. Fetch memberships to get organization and member IDs.
        const membershipsResponse = await client.getMemberships();
        if (membershipsResponse.data && membershipsResponse.data.length > 0) {
            organizationId = membershipsResponse.data[0].organization.id;
            memberId = membershipsResponse.data[0].id;
            streamDeck.logger.info(`Found Organization ID: ${organizationId}`);
            streamDeck.logger.info(`Found Member ID: ${memberId}`);

            // Provide the fetched context to the action instance.
            toggleAction.setContext({
                organizationId: organizationId,
                memberId: memberId,
                triggerPoll: pollActiveTimer,
                triggerRefresh: () => fetchInitialData(client)
            });

        } else {
            streamDeck.logger.warn("User does not appear to be part of any organization.");
            return;
        }

        // 2. Fetch projects.
        const projectsResponse = await client.getActiveProjects(organizationId);
        projects = projectsResponse.data || [];
        streamDeck.logger.info(`Fetched ${projects.length} active projects.`);
        toggleAction.setProjects(projects);

        // 3. Do an initial poll for the active timer.
        await pollActiveTimer();

    } catch (error) {
        streamDeck.logger.error("An error occurred while fetching initial data. Resetting state.");
        console.error(error);
        activeTimeEntry = undefined;
        toggleAction.updateAllButtonStates(undefined);
    }
}


/**
 * Initializes (or re-initializes) the ApiClient when settings are provided.
 * @param settings The global settings from the Stream Deck store.
 */
function initializeApiClient(settings: GlobalSettings): void {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = undefined;
    }

    if (settings.solidtimeBaseUrl && settings.accessToken) {
        streamDeck.logger.info("Valid global settings found, initializing API client.");
        apiClient = new ApiClient({
            baseUrl: settings.solidtimeBaseUrl,
            accessToken: settings.accessToken,
        });

        // Provide the newly created client to our action instance and fetch data.
        toggleAction.setApiClient(apiClient);
        fetchInitialData(apiClient);
        pollingInterval = setInterval(pollActiveTimer, 5000);

    } else {
        streamDeck.logger.warn("Global settings are incomplete, API client not initialized.");
        apiClient = undefined;
        activeTimeEntry = undefined;
        toggleAction.updateAllButtonStates(undefined);
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
});

// --- Plugin Entry Point ---
streamDeck.connect();
