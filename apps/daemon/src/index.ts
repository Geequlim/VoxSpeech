import { canAcceptSynthesis } from "@voxspeech/engine-client";

export interface DaemonStatus {
	readonly acceptingRequests: boolean;
	readonly state: "starting";
}

export function createInitialDaemonStatus(): DaemonStatus {
	return {
		acceptingRequests: canAcceptSynthesis("starting"),
		state: "starting",
	};
}
