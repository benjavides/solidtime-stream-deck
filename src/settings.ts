// src/settings.ts

export type GlobalSettings = {
    solidtimeBaseUrl?: string;
    accessToken?: string;
    organizationId?: string;
};

// We will add Action-specific settings here later.
export type ActionSettings = {
    projectId?: string;
    billable?: boolean;
};