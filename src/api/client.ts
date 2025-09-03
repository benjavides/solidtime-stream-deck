import {
    Membership,
    Paginated,
    Project,
    Tag,
    Response as ApiResponse,
    TimeEntry,
    TimeEntryStartRequest,
    TimeEntryStopRequest,
} from "./types";

/**
 * Defines the options required to initialize the ApiClient.
 */
type ApiClientOptions = {
    baseUrl: string;
    accessToken: string;
};

/**
 * A client for making authenticated requests to the Solidtime API.
 * This class abstracts the raw fetch calls into dedicated, typed methods.
 */
export class ApiClient {
    private options: ApiClientOptions;

    constructor(options: ApiClientOptions) {
        if (!options.baseUrl || !options.accessToken) {
            throw new Error('ApiClient requires a baseUrl and accessToken.');
        }
        this.options = options;
    }

    /**
     * Creates the standard headers required for every API request.
     */
    private getHeaders(): Headers {
        const headers = new Headers();
        headers.append('Authorization', `Bearer ${this.options.accessToken}`);
        headers.append('Content-Type', 'application/json');
        headers.append('Accept', 'application/json');
        return headers;
    }
    
    /**
     * A generic method to perform a GET request.
     */
    private async get<T>(path: string): Promise<T> {
        const url = `${this.options.baseUrl}${path}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: this.getHeaders(),
        });
        return this.handleResponse<T>(response);
    }

    /**
     * A generic method to perform a POST request.
     */
    private async post<T>(path: string, body: unknown): Promise<T> {
        const url = `${this.options.baseUrl}${path}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(body),
        });
        return this.handleResponse<T>(response);
    }

    /**
     * A generic method to perform a PUT request.
     */
    private async put<T>(path: string, body: unknown): Promise<T> {
        const url = `${this.options.baseUrl}${path}`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: this.getHeaders(),
            body: JSON.stringify(body),
        });
        return this.handleResponse<T>(response);
    }

    /**
     * A generic method to perform a PATCH request.
     */
    private async patch<T>(path: string, body: unknown): Promise<T> {
        const url = `${this.options.baseUrl}${path}`;
        const response = await fetch(url, {
            method: 'PATCH',
            headers: this.getHeaders(),
            body: JSON.stringify(body),
        });
        return this.handleResponse<T>(response);
    }

    /**
     * Handles the response from the fetch call, checking for errors.
     */
    private async handleResponse<T>(response: globalThis.Response): Promise<T> {
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorBody}`);
        }
        
        // Handle 204 No Content responses
        if (response.status === 204) {
            return {} as T;
        }

        return response.json() as Promise<T>;
    }

    // =================================================================
    //  Dedicated Endpoint Methods
    // =================================================================

    /**
     * Fetches the memberships for the current user.
     * Corresponds to: GET /v1/users/me/memberships
     */
    public getMemberships(): Promise<ApiResponse<Membership[]>> {
        return this.get('/v1/users/me/memberships');
    }

    /**
     * Fetches all non-archived projects for a given organization.
     * Corresponds to: GET /v1/organizations/{org}/projects?archived=false
     * @param organizationId The ID of the organization.
     */
    public getActiveProjects(organizationId: string): Promise<Paginated<Project>> {
        return this.get(`/v1/organizations/${organizationId}/projects?archived=false`);
    }

    /**
     * Fetches the currently active time entry for the user.
     * Corresponds to: GET /v1/users/me/time-entries/active
     */
    public getActiveTimeEntry(): Promise<ApiResponse<TimeEntry>> {
        return this.get('/v1/users/me/time-entries/active');
    }

    /**
     * Creates a new time entry (starts a timer).
     * Corresponds to: POST /v1/organizations/{org}/time-entries
     * @param organizationId The ID of the organization.
     * @param data The details for the new time entry.
     */
    public startTimeEntry(organizationId: string, data: TimeEntryStartRequest): Promise<ApiResponse<TimeEntry>> {
        return this.post(`/v1/organizations/${organizationId}/time-entries`, data);
    }

    /**
     * Updates a time entry, typically to stop it.
     * Corresponds to: PUT /v1/organizations/{org}/time-entries/{id}
     * @param organizationId The ID of the organization.
     * @param timeEntryId The ID of the time entry to update.
     * @param data The update payload (e.g., the end time).
     */
    public stopTimeEntry(organizationId: string, timeEntryId: string, data: TimeEntryStopRequest): Promise<ApiResponse<TimeEntry>> {
        return this.put(`/v1/organizations/${organizationId}/time-entries/${timeEntryId}`, data);
    }

    /**
     * Lists tags for an organization.
     * GET /v1/organizations/{organization}/tags
     */
    public getTags(organizationId: string): Promise<ApiResponse<Tag[]>> {
        return this.get(`/v1/organizations/${organizationId}/tags`);
    }

    /**
     * Patches one or more time entries for an organization.
     * PATCH /v1/organizations/{organization}/time-entries
     * Note: Do not log tag IDs or sensitive payload details.
     */
    public patchTimeEntries(
        organizationId: string,
        ids: string[],
        changes: Partial<{ tags: string[]; description: string | null }>
    ): Promise<ApiResponse<TimeEntry[]>> {
        return this.patch(`/v1/organizations/${organizationId}/time-entries`, { ids, changes });
    }
}
