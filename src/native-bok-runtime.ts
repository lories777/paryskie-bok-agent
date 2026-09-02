import {
  NATIVE_BOK_PROVIDER,
  type NativeBokRuntimeStatus,
} from "./native-bok-contract.js";
import type {
  NativeOperationalActionDispatchRuntimeStatus,
} from "./native-bok-operational-dispatch.js";

export interface NativeBokRuntimeStatusPort {
  runtimeStatus(): NativeBokRuntimeStatus;
}

export interface NativeOperationalActionRuntimeStatusPort {
  runtimeStatus(): NativeOperationalActionDispatchRuntimeStatus;
}

export type FullNativeBokRuntimeStatus = NativeBokRuntimeStatus & {
  ok: true;
  operationalActionDispatch: NativeOperationalActionDispatchRuntimeStatus;
};

/** Jedno źródło exact heartbeat dla loopback API i outbound pollera. */
export function fullNativeBokRuntimeStatus(
  inference: NativeBokRuntimeStatusPort,
  dispatcher: NativeOperationalActionRuntimeStatusPort,
): FullNativeBokRuntimeStatus {
  const status = inference.runtimeStatus();
  if (status.provider !== NATIVE_BOK_PROVIDER) {
    throw new Error("native_runtime_provider_mismatch");
  }
  return {
    ok: true,
    ...status,
    operationalActionDispatch: dispatcher.runtimeStatus(),
  };
}
