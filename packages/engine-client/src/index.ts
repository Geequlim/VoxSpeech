export type EngineLifecycleState = "starting" | "ready" | "busy" | "stopping" | "stopped";

export function canAcceptSynthesis(state: EngineLifecycleState): boolean {
	return state === "ready";
}
