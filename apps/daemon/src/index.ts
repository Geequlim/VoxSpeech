export * from "./engine-synthesis.js";
export * from "./fake-synthesis.js";
export * from "./server.js";
export * from "./runtime.js";
export * from "./synthesis-service.js";
export * from "./models/index.js";
export * from "./voices/index.js";

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
