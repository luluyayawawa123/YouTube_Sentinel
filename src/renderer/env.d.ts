declare global {
  interface Window {
    desktop: {
      version: string;
      openExternal: (url: string) => void;
    };
  }
}

export {};
