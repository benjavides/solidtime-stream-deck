// src/settings.ts

export type GlobalSettings = {
    solidtimeBaseUrl?: string;
    accessToken?: string;
};

// We will add Action-specific settings here later.
export type ActionSettings = {
    organizationId?: string;
    projectId?: string;
    billable?: boolean;
    showElapsedTime?: boolean;
    titleOverride?: string;
    tagIds?: string[]; // selected tag IDs (multi-select)
};
