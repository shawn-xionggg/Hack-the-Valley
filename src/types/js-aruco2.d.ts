declare module "js-aruco2" {
  export const AR: {
    DICTIONARIES: Record<string, { nBits: number; tau: number | null; codeList: (number | number[] | string)[] }>;
    Detector: new (config: { dictionaryName: string; maxHammingDistance?: number }) => {
      detect(image: { width: number; height: number; data: Uint8ClampedArray }): {
        id: number; corners: { x: number; y: number }[]; hammingDistance: number;
      }[];
    };
    Dictionary: new (name: string) => {
      codeList: string[];
      generateSVG(id: number): string;
    };
  };
}

declare module "js-aruco2/src/dictionaries/aruco_4x4_1000.js";
