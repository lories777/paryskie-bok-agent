import {
  NATIVE_BOK_PROVIDER,
  type NativeBokRuntimeStatus,
} from "./native-bok-contract.js";
import type {
  NativeOperationalActionDispatchRuntimeStatus,
} from "./native-bok-operational-dispatch.js";
import {
  nativeBokDecisionCapabilityStatus,
  type NativeBokDecisionCapabilityStatus,
} from "./native-bok-decision-capability.js";

export interface NativeBokRuntimeStatusPort {
  runtimeStatus(): NativeBokRuntimeStatus;
}

export interface NativeOperationalActionRuntimeStatusPort {
  runtimeStatus(): NativeOperationalActionDispatchRuntimeStatus;
}

export interface NativeBokDecisionCapabilityStatusPort {
  decisionCapabilityStatus(): NativeBokDecisionCapabilityStatus;
}

export type FullNativeBokRuntimeStatus = NativeBokRuntimeStatus & {
  ok: true;
  decisionCapability: NativeBokDecisionCapabilityStatus;
  operationalActionDispatch: NativeOperationalActionDispatchRuntimeStatus;
};

/** Jedno źródło exact heartbeat dla loopback API i outbound pollera. */
export function fullNativeBokRuntimeStatus(
  inference: NativeBokRuntimeStatusPort,
  dispatcher: NativeOperationalActionRuntimeStatusPort,
  decision?: NativeBokDecisionCapabilityStatusPort,
): FullNativeBokRuntimeStatus {
  const status = inference.runtimeStatus();
  if (status.provider !== NATIVE_BOK_PROVIDER) {
    throw new Error("native_runtime_provider_mismatch");
  }
  return {
    ok: true,
    ...status,
    decisionCapability: decision?.decisionCapabilityStatus() ?? nativeBokDecisionCapabilityStatus({
      sharedEngine: false,
      daktelaRead: false,
      masterlinkRead: false,
      attachmentEvidence: false,
      independentJudge: false,
    }),
    operationalActionDispatch: dispatcher.runtimeStatus(),
  };
}
