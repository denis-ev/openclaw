import type { QaProviderModeInput } from "../../model-selection.js";
import { QA_ADAPTER_PREPARED_FLOW_CONTEXT_CAPABILITIES } from "../shared/live-transport-cli.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";

export function resolveWhatsAppQaScenarioIds(params: {
  profile?: string;
  primaryModel?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}) {
  return resolveLiveTransportQaScenarioIds({
    channelId: "whatsapp",
    implementationCapabilities: QA_ADAPTER_PREPARED_FLOW_CONTEXT_CAPABILITIES,
    ...params,
  });
}
