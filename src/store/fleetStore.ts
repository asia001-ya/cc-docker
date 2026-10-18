/**
 * 容器汇总 store：订阅后端 fleet://update；演示模式下使用 DEMO_FLEET。
 */
import { create } from "zustand";
import type { FleetEntry, FleetState } from "../api/types";

interface FleetStore {
  /** 最近一次汇总 */
  fleet: FleetState;
  /** 是否演示模式 */
  demo: boolean;
  /** 更新汇总 */
  setFleet: (f: FleetState) => void;
  /** 设置演示模式 */
  setDemo: (d: boolean) => void;
}

export const useFleetStore = create<FleetStore>((set) => ({
  fleet: { engineOk: false, engineError: null, latencyMs: null, engineVersion: null, entries: [], generatedAt: 0 },
  demo: false,
  setFleet: (fleet) => set({ fleet }),
  setDemo: (demo) => set({ demo }),
}));

/**
 * 按容器名取汇总项。
 * @param name 容器名
 * @returns 汇总项或 undefined
 */
export function useEntry(name: string | null | undefined): FleetEntry | undefined {
  return useFleetStore((s) => (name ? s.fleet.entries.find((e) => e.container.name === name) : undefined));
}
