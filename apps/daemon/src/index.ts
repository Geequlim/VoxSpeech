export * from "./fake-synthesis.js";
export * from "./server.js";

export interface DaemonStatus {
	readonly acceptingRequests: boolean;
	readonly state: "starting";
}

export function createInitialDaemonStatus(): DaemonStatus {
	return {
		acceptingRequests: false,
		state: "starting",
	};
}
