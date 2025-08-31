import streamDeck, { DeviceDidConnectEvent, DidReceiveGlobalSettingsEvent, LogLevel } from "@elgato/streamdeck";
import { ApiClient } from "./api/client";
import { ToggleProjectAction } from "./actions/toggle-project";
import { GlobalSettings } from "./settings";
import { Project, TimeEntry } from "./api/types";

// --- Setup ---
streamDeck.logger.setLevel(LogLevel.DEBUG);

// --- Plugin-wide State Management ---
let apiClient: ApiClient | undefined;
let organizationId: string | undefined;
let memberId: string | undefined;
let projects: Project[] = [];
let activeTimeEntry: TimeEntry | undefined;
let pollingInterval: NodeJS.Timeout | undefined;
let isPolling = false; // The lock to prevent overlapping polls.

// --- Action Registration ---
const toggleAction = new ToggleProjectAction();
streamDeck.actions.registerAction(toggleAction);

// --- Core Logic Functions ---

async function pollActiveTimer(): Promise<void> {
    if (!apiClient || isPolling) {
        return; // Don't run if not configured or if a poll is already in progress.
    }

    isPolling = true; // Set the lock.
    try {
        const activeEntryResponse = await apiClient.getActiveTimeEntry();
        activeTimeEntry = activeEntryResponse.data;
    } catch (error) {
        activeTimeEntry = undefined;
    }

    await toggleAction.updateAllButtonStates(activeTimeEntry);
    isPolling = false; // Release the lock.
}

async function fetchInitialData(client: ApiClient): Promise<void> {
    streamDeck.logger.info("Fetching initial data from Solidtime API...");
    try {
        const membershipsResponse = await client.getMemberships();
        if (membershipsResponse.data && membershipsResponse.data.length > 0) {
            organizationId = membershipsResponse.data[0].organization.id;
            memberId = membershipsResponse.data[0].id;
            streamDeck.logger.info(`Found Organization ID: ${organizationId}`);
            streamDeck.logger.info(`Found Member ID: ${memberId}`);

            toggleAction.setContext({
                organizationId: organizationId,
                memberId: memberId,
                triggerPoll: pollActiveTimer,
                triggerRefresh: () => fetchInitialData(client),
                getActiveTimeEntry: () => activeTimeEntry
            });
        } else {
            streamDeck.logger.warn("User does not appear to be part of any organization.");
            return;
        }

        const projectsResponse = await client.getActiveProjects(organizationId);
        projects = projectsResponse.data || [];
        streamDeck.logger.info(`Fetched ${projects.length} active projects.`);
        toggleAction.setProjects(projects);

        await pollActiveTimer();

    } catch (error) {
        streamDeck.logger.error("An error occurred while fetching initial data. Resetting state.");
        console.error(error);
        activeTimeEntry = undefined;
        await toggleAction.updateAllButtonStates(undefined);
    }
}

async function initializeApiClient(settings: GlobalSettings): Promise<void> {
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
        
        toggleAction.setApiClient(apiClient);
        await fetchInitialData(apiClient);
        pollingInterval = setInterval(pollActiveTimer, 5000);
    } else {
        streamDeck.logger.warn("Global settings are incomplete, API client not initialized.");
        apiClient = undefined;
        activeTimeEntry = undefined;
        await toggleAction.updateAllButtonStates(undefined);
    }
}

// --- Event Listeners ---

streamDeck.settings.onDidReceiveGlobalSettings(async (ev: DidReceiveGlobalSettingsEvent<GlobalSettings>) => {
    streamDeck.logger.info("Global settings were updated by the UI.");
    await initializeApiClient(ev.settings);
});

streamDeck.devices.onDeviceDidConnect(async (ev: DeviceDidConnectEvent) => {
    streamDeck.logger.info(`Device ${ev.device.name} connected.`);
    streamDeck.logger.info("Checking for existing global settings...");
    const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
    await initializeApiClient(settings);
});

// --- Plugin Entry Point ---
streamDeck.connect();

