import streamDeck, { DeviceDidConnectEvent, DidReceiveGlobalSettingsEvent, LogLevel } from "@elgato/streamdeck";
import { ApiClient } from "./api/client";
import { ToggleProjectAction } from "./actions/toggle-project";
import { GlobalSettings } from "./settings";
import { Project, TimeEntry, Membership } from "./api/types";

// --- Setup ---
streamDeck.logger.setLevel(LogLevel.DEBUG);

// --- Plugin-wide State Management ---
let apiClient: ApiClient | undefined;
let organizationId: string | undefined;
let memberId: string | undefined;
let projects: Project[] = [];
let memberships: Membership[] = [];
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

async function fetchProjectsForOrg(orgId: string): Promise<void> {
    if (!apiClient) return;

    try {
        const projectsResponse = await apiClient.getActiveProjects(orgId);
        projects = projectsResponse.data || [];
        streamDeck.logger.info(`Fetched ${projects.length} active projects for org ${orgId}.`);
        toggleAction.setProjects(projects);

        // The UI will now request this data when it needs it, so no broadcast is needed here.

    } catch (error) {
        streamDeck.logger.error(`Failed to fetch projects for org ${orgId}:`, error);
        projects = [];
        toggleAction.setProjects([]);
    }
}

async function fetchInitialData(client: ApiClient): Promise<void> {
    streamDeck.logger.info("Fetching initial data from Solidtime API...");
    try {
        const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
        const membershipsResponse = await client.getMemberships();
        memberships = membershipsResponse.data || [];
        toggleAction.setMemberships(memberships); // Provide memberships to the action

        if (memberships.length > 0) {
            let currentOrgId = settings.organizationId;
            
            // Auto-select the first organization if none is currently set.
            if (!currentOrgId || !memberships.some(m => m.organization.id === currentOrgId)) {
                currentOrgId = memberships[0].organization.id;
                streamDeck.logger.info(`No organization selected or previous one invalid. Auto-selecting first: ${currentOrgId}`);
                // Save it back to settings. This will trigger onDidReceiveGlobalSettings to fetch projects.
                await streamDeck.settings.setGlobalSettings({ ...settings, organizationId: currentOrgId });
            } else {
                 // If an org is already selected, proceed with it.
                 organizationId = currentOrgId;
                 memberId = memberships.find(m => m.organization.id === organizationId)?.id;
                 await fetchProjectsForOrg(organizationId);
            }
        } else {
            streamDeck.logger.warn("User does not appear to be part of any organization.");
            return;
        }
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
    
    const newSettings = ev.settings;
    const oldOrgId = organizationId;
    const newOrgId = newSettings.organizationId;

    // Check if credentials have changed, requiring a full re-initialization.
    const credentialsChanged = !apiClient || (
        apiClient['options'].baseUrl !== newSettings.solidtimeBaseUrl ||
        apiClient['options'].accessToken !== newSettings.accessToken
    );

    if (credentialsChanged) {
        await initializeApiClient(newSettings);
        return;
    }

    // If only the organization has changed, fetch new projects for it.
    if (newOrgId && newOrgId !== oldOrgId) {
        streamDeck.logger.info(`Organization changed from ${oldOrgId} to ${newOrgId}. Fetching new projects.`);
        organizationId = newOrgId;
        memberId = memberships.find(m => m.organization.id === organizationId)?.id;
        
        if (memberId) {
            // Update the context for the action
            toggleAction.setContext({
                organizationId: organizationId,
                memberId: memberId,
                triggerPoll: pollActiveTimer,
                triggerRefresh: () => fetchInitialData(apiClient!),
                getActiveTimeEntry: () => activeTimeEntry
            });
            await fetchProjectsForOrg(newOrgId);
        } else {
            streamDeck.logger.error(`Could not find memberId for organization ${newOrgId}`);
        }
    }
});

streamDeck.devices.onDeviceDidConnect(async (ev: DeviceDidConnectEvent) => {
    streamDeck.logger.info(`Device ${ev.device.name} connected.`);
    streamDeck.logger.info("Checking for existing global settings...");
    const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
    await initializeApiClient(settings);
});

// --- Plugin Entry Point ---
streamDeck.connect();

