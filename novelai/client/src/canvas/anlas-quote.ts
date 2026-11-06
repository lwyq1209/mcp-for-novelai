import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { adaptiveNAIImageSize } from '../nai-dimensions';
import type { AnlasQuoteFeature, AnlasQuoteResult } from '../types';

/**
 * The cost shown before a manual generation (step 4b3: moved here unchanged from the old FeatureCostCard of App.tsx,
 * which now uses it as well): the same quote request for the same canvas state, re-read 250 ms after any input of the
 * quote changes. Only shows a number; the Generate click quotes again (store ensureAnlasBeforeRun) before it queues.
 */
/** Enhance Max✨: the request size and strength of its click (the quote is read for the about-2× result). */
export interface QuoteOverride { width: number; height: number; strength: number; upscaledEnhance: true }

export function useAnlasQuote(feature: AnlasQuoteFeature, override?: QuoteOverride): { quote: AnlasQuoteResult | null; loading: boolean } {
  const account = useAppStore((state) => state.account);
  const params = useAppStore((state) => feature === "inpaint" && state.inpaintRecipe ? state.inpaintRecipe : state.params);
  const batchCount = useAppStore((state) => state.batchCount);
  const i2iParams = useAppStore((state) => state.i2iParams);
  const i2iSizeMode = useAppStore((state) => state.i2iSizeMode);
  const inpaintStrength = useAppStore((state) => state.inpaintStrength);
  const inpaintModel = useAppStore((state) => state.inpaintModel);
  const inpaintMask = useAppStore((state) => state.inpaintMask);
  const upscaleScale = useAppStore((state) => state.upscaleScale);
  const directorTool = useAppStore((state) => state.directorTool);
  const workbenchImage = useAppStore((state) => state.workbenchImage);
  const vibeCount = useAppStore((state) => state.vibeImages.length);
  const preciseCount = useAppStore((state) => state.preciseReferences.length);
  const [quote, setQuote] = useState<AnlasQuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const balance = account.anlasBalance;
  const quoteKey = JSON.stringify({
    feature,
    model: params.model,
    effort: params.effort ?? "high",
    override: override ?? null,
    width: params.width,
    height: params.height,
    steps: params.steps,
    smea: params.smea,
    smeaDyn: params.smeaDyn,
    batchCount,
    strength: i2iParams.strength,
    i2iSizeMode,
    inpaintStrength,
    inpaintModel,
    hasMask: Boolean(inpaintMask),
    upscaleScale,
    directorTool,
    workbenchPath: workbenchImage?.filePath ?? "",
    workbenchWidth: workbenchImage?.width ?? 0,
    workbenchHeight: workbenchImage?.height ?? 0,
    vibeCount,
    preciseCount,
    hasToken: account.hasToken,
    tierLevel: account.tierLevel,
    active: account.hasActiveSubscription,
    balance,
  });

  useEffect(() => {
    let cancelled = false;
    if (!account.hasToken) {
      setQuote(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      const quoteSize = override ? { width: override.width, height: override.height } : feature === "inpaint" && workbenchImage
        ? { width: workbenchImage.width, height: workbenchImage.height }
        : feature === "i2i" && i2iSizeMode === "adaptive" && workbenchImage
          ? adaptiveNAIImageSize(workbenchImage.width, workbenchImage.height, params)
          : { width: params.width, height: params.height };
      const quoteParams = {
        ...params,
        ...quoteSize,
        stylePrompt: "",
        positivePrompt: "quote",
        negativePrompt: "",
      };
      const extras = {
        vibeImages: Array.from({ length: vibeCount }, () => ({ base64: "", infoExtracted: 1, strength: 1 })),
        charCaptions: [],
        preciseReferences: Array.from({ length: preciseCount }, () => ({
          base64: "",
          type: "character" as const,
          strength: 1,
          fidelity: 1,
        })),
      };
      void window.naiDesktop
        .quoteAnlas({
          feature,
          params: quoteParams,
          extras,
          batchCount,
          i2iParams: override ? { ...i2iParams, strength: override.strength, noise: 0, upscaledEnhance: true } : { ...i2iParams, noise: 0 },
          inpaintStrength,
          inpaintNoise: 0,
          inpaintModel,
          maskBase64: inpaintMask,
          upscaleScale,
          directorTool,
          image: workbenchImage
            ? { width: workbenchImage.width, height: workbenchImage.height }
            : null,
          account,
        })
        .then((result) => {
          if (!cancelled) setQuote(result);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [quoteKey]);

  return { quote, loading };
}
