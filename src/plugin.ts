import streamDeck, { DeviceDidConnectEvent, DidReceiveGlobalSettingsEvent, LogLevel } from "@elgato/streamdeck";
import { ApiClient } from "./api/client";
import { ToggleProjectAction } from "./actions/toggle-project";
import { GlobalSettings } from "./settings";
import { Project, TimeEntry, Membership, Tag } from "./api/types";

// --- Setup ---
streamDeck.logger.setLevel(LogLevel.DEBUG);

// --- Plugin-wide State Management ---
let apiClient: ApiClient | undefined;
let activeTimeEntry: TimeEntry | undefined;
let pollingInterval: NodeJS.Timeout | undefined;
let isPolling = false; // The lock to prevent overlapping polls.

// Caches
const MEMBERSHIP_TTL_MS = 60_000;
const PROJECTS_TTL_MS = 60_000;
const TAGS_TTL_MS = 60_000;

let membershipsCache: { data: Membership[]; timestamp: number } | undefined;
let membershipsInFlight: Promise<Membership[]> | undefined;
const projectsCache = new Map<string, { data: Project[]; timestamp: number; inFlight?: Promise<Project[]> }>();
const tagsCache = new Map<string, { data: Tag[]; timestamp: number; inFlight?: Promise<Tag[]> }>();

// --- Validation helpers ---
function normalizeBaseUrl(url?: string): string | undefined {
    if (!url) return undefined;
    const trimmed = url.trim();
    if (trimmed.endsWith('/api')) return trimmed; // correct
    if (trimmed.endsWith('/api/')) return trimmed.slice(0, -1); // normalize trailing slash
    return undefined; // invalid according to our rule
}

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

// --- Caching helpers ---
async function ensureMemberships(force = false): Promise<Membership[]> {
    if (!apiClient) return [];

    const now = Date.now();
    if (!force && membershipsCache && now - membershipsCache.timestamp < MEMBERSHIP_TTL_MS) {
        return membershipsCache.data;
    }
    if (membershipsInFlight) {
        return membershipsInFlight;
    }
    membershipsInFlight = (async () => {
        try {
            const res = await apiClient!.getMemberships();
            const data = res.data || [];
            membershipsCache = { data, timestamp: Date.now() };
            toggleAction.setMemberships(data);
            return data;
        } catch (err) {
            const msg = String(err);
            if (msg.includes("401") || msg.includes("403")) {
                membershipsCache = undefined;
            }
            streamDeck.logger.error("Failed to fetch memberships:", err);
            return [];
        } finally {
            membershipsInFlight = undefined;
        }
    })();
    return membershipsInFlight;
}

async function ensureProjectsForOrg(orgId: string, force = false): Promise<Project[]> {
    if (!apiClient) return [];
    const entry = projectsCache.get(orgId);
    const now = Date.now();
    if (!force && entry && now - entry.timestamp < PROJECTS_TTL_MS) {
        return entry.data;
    }
    if (entry?.inFlight) {
        return entry.inFlight;
    }
    const inFlight = (async () => {
        try {
            const res = await apiClient!.getActiveProjects(orgId);
            const data = res.data || [];
            projectsCache.set(orgId, { data, timestamp: Date.now() });
            return data;
        } catch (err) {
            const msg = String(err);
            if (msg.includes("401") || msg.includes("403")) {
                projectsCache.delete(orgId);
            }
            streamDeck.logger.error(`Failed to fetch projects for org ${orgId}:`, err);
            return [];
        } finally {
            const current = projectsCache.get(orgId);
            if (current) {
                delete current.inFlight;
            }
        }
    })();
    projectsCache.set(orgId, { data: entry?.data || [], timestamp: entry?.timestamp || 0, inFlight });
    return inFlight;
}

async function ensureTagsForOrg(orgId: string, force = false): Promise<Tag[]> {
    if (!apiClient) return [];
    const entry = tagsCache.get(orgId);
    const now = Date.now();
    if (!force && entry && now - entry.timestamp < TAGS_TTL_MS) {
        return entry.data;
    }
    if (entry?.inFlight) {
        return entry.inFlight;
    }
    const inFlight = (async () => {
        try {
            const res = await apiClient!.getTags(orgId);
            const data = res.data || [];
            tagsCache.set(orgId, { data, timestamp: Date.now() });
            return data;
        } catch (err) {
            const msg = String(err);
            if (msg.includes("401") || msg.includes("403")) {
                tagsCache.delete(orgId);
            }
            // Keep prior list if available
            const prior = tagsCache.get(orgId)?.data || [];
            streamDeck.logger.error(`Failed to fetch tags for org ${orgId}:`, err);
            // Surface a non-blocking PI error
            try {
                (streamDeck.ui.current as any)?.sendToPropertyInspector?.({ event: 'tagsFetchError', message: 'Failed to fetch tags. Showing cached list if available.' });
            } catch {}
            return prior;
        } finally {
            const current = tagsCache.get(orgId);
            if (current) {
                delete current.inFlight;
            }
        }
    })();
    tagsCache.set(orgId, { data: entry?.data || [], timestamp: entry?.timestamp || 0, inFlight });
    return inFlight;
}

function getMemberIdForOrg(orgId: string): string | undefined {
    const memberships = membershipsCache?.data || [];
    return memberships.find(m => m.organization.id === orgId)?.id;
}

async function initializeApiClient(settings: GlobalSettings): Promise<void> {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = undefined;
    }

    const normalizedBaseUrl = normalizeBaseUrl(settings.solidtimeBaseUrl);
    if (normalizedBaseUrl && settings.accessToken) {
        streamDeck.logger.info("Valid global settings found, initializing API client.");
        apiClient = new ApiClient({
            baseUrl: normalizedBaseUrl,
            accessToken: settings.accessToken,
        });
        
        // Set the API client and provide context hooks
        toggleAction.setApiClient(apiClient);
        toggleAction.setContext({
            triggerPoll: pollActiveTimer,
            triggerRefresh: async () => {
                // Force refresh memberships and clear projects cache
                await ensureMemberships(true);
                projectsCache.clear();
                tagsCache.clear();
            },
            getActiveTimeEntry: () => activeTimeEntry,
            getProjectsForOrg: async (orgId: string, opts?: { refresh?: boolean }) => {
                return ensureProjectsForOrg(orgId, Boolean(opts?.refresh));
            },
            getMemberIdForOrg: (orgId: string) => getMemberIdForOrg(orgId),
            getTagsForOrg: async (orgId: string, opts?: { refresh?: boolean }) => {
                return ensureTagsForOrg(orgId, Boolean(opts?.refresh));
            },
        });

        // Prime memberships cache
        await ensureMemberships(true);
        pollingInterval = setInterval(pollActiveTimer, 5000);
    } else {
        if (!settings.solidtimeBaseUrl) {
            streamDeck.logger.warn("Global settings missing base URL, API client not initialized.");
        } else if (!normalizeBaseUrl(settings.solidtimeBaseUrl)) {
            streamDeck.logger.warn("Solidtime URL must end with '/api'. API client not initialized.");
        } else if (!settings.accessToken) {
            streamDeck.logger.warn("Global settings missing access token, API client not initialized.");
        }
        apiClient = undefined;
        activeTimeEntry = undefined;
        await toggleAction.updateAllButtonStates(undefined);
    }
}

// --- Event Listeners ---

streamDeck.settings.onDidReceiveGlobalSettings(async (ev: DidReceiveGlobalSettingsEvent<GlobalSettings>) => {
    streamDeck.logger.info("Global settings were updated by the UI.");
    const newSettings = ev.settings;
    const normalizedBaseUrl = normalizeBaseUrl(newSettings.solidtimeBaseUrl);

    // Check if credentials have changed, requiring a full re-initialization.
    const credentialsChanged = !apiClient || (
        // Comparing current vs new to decide re-init
        (apiClient as any)['options'].baseUrl !== normalizedBaseUrl ||
        (apiClient as any)['options'].accessToken !== newSettings.accessToken
    );

    if (credentialsChanged) {
        await initializeApiClient(newSettings);
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

