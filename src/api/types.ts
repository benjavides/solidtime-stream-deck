// Standard wrapper for single-item or collection responses.
export type Response<T> = {
    data: T;
};

// Standard wrapper for paginated responses.
export type Paginated<T> = {
    data: T[];
    links: {
        first: string | null;
        last: string | null;
        prev: string | null;
        next: string | null;
    };
    meta: {
        current_page: number;
        from: number | null;
        last_page: number;
        path: string;
        per_page: number;
        to: number | null;
        total: number;
    };
};

// From GET /v1/users/me/memberships
export type Membership = {
    id: string;
    organization: {
        id: string;
        name: string;
        currency: string;
    };
    role: "owner" | "admin" | "manager" | "employee";
};

// From GET /v1/organizations/{org}/projects
export type Project = {
    id: string;
    name: string;
    color: string;
    client_id: string | null;
    is_archived: boolean;
    billable_rate: number | null;
    is_billable: boolean;
    estimated_time: number | null;
    spent_time: number;
    is_public: boolean;
};

// From GET /v1/users/me/time-entries/active
// Also used for POST and PUT time entry responses.
export type TimeEntry = {
    id: string;
    start: string; // ISO 8601 string: "2024-02-26T17:17:17Z"
    end: string | null; // ISO 8601 string or null
    duration: number | null; // in seconds
    description: string | null;
    task_id: string | null;
    project_id: string | null;
    organization_id: string;
    user_id: string;
    tags: string[];
    billable: boolean;
};

// For POST /v1/organizations/{org}/time-entries
export type TimeEntryStartRequest = {
    member_id: string;
    project_id: string;
    start: string; // ISO 8601 string
    billable: boolean;
    description?: string | null;
    task_id?: string | null;
    tags?: string[] | null;
};

// For PUT /v1/organizations/{org}/time-entries/{id}
export type TimeEntryStopRequest = {
    end: string; // ISO 8601 string
};
