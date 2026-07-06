import type { OatmealApi } from "../electron/preload";

declare global {
  interface Window {
    oatmeal: OatmealApi;
  }
}

export {};
