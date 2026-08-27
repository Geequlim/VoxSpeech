import { ProxyAgent } from "proxy-agent";

export function createProxyAgent(proxy?: string): ProxyAgent {
	return new ProxyAgent(proxy ? { getProxyForUrl: () => proxy } : undefined);
}
