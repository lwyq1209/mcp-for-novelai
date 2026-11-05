import { useEffect, useRef, useState, type KeyboardEvent, type ChangeEvent } from "react";
import clsx from "clsx";
import { useAppStore } from "../store";
import { fmtCount, wordAtCursor } from "../text-utils";
import { CAT_COLOR, localizedCategoryLabel, tagDescription } from "../prompt-data";
import type { TagSuggestion } from "../types";

/* Moved unchanged from App.tsx (step 4b3): the prompt textarea with Danbooru tag completion, used by the new canvas
   and the old panels that remain until they are replaced. */

// Pixel position of the caret inside a textarea (relative to the textarea's own
// top-left), via a hidden mirror element — used to anchor the autocomplete
// dropdown right under the character being typed instead of at the box bottom.
function caretCoordinates(el: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const computed = window.getComputedStyle(el);
  const div = document.createElement("div");
  const copyProps = [
    "boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "fontSizeAdjust",
    "lineHeight", "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
  ] as const;
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.overflow = "hidden";
  for (const prop of copyProps) {
    (div.style as unknown as Record<string, string>)[prop] = computed.getPropertyValue(
      prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()),
    );
  }
  div.textContent = el.value.slice(0, position);
  const span = document.createElement("span");
  span.textContent = el.value.slice(position) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.3;
  const result = {
    top: span.offsetTop + parseFloat(computed.borderTopWidth || "0"),
    left: span.offsetLeft + parseFloat(computed.borderLeftWidth || "0"),
    height: lineHeight,
  };
  document.body.removeChild(div);
  return result;
}

// ── PromptTextarea: textarea with Danbooru tag autocomplete ───────────────────
export function PromptTextarea({
  value,
  onChange,
  model,
  enabled,
  placeholder,
  className,
  ariaLabel,
  rows,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  model: string;
  enabled: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  rows?: number;
  testId?: string;
}) {
  const language = useAppStore((state) => state.settings?.language);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  // Only the vertical caret position — the dropdown stays full-width so long tag
  // text never overflows/clips horizontally.
  const [acTop, setAcTop] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const composingRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function clearSuggestions() { setSuggestions([]); setAcTop(null); }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    const cursor = e.target.selectionStart ?? text.length;
    onChange(text);
    setActiveIdx(0);
    if (!enabled || composingRef.current) {
      clearSuggestions();
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    const { word } = wordAtCursor(text, cursor);
    if (word.length < 1) {
      clearSuggestions();
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await window.naiDesktop.suggestTags(model, word);
        setSuggestions(res.slice(0, 8));
        const ta = taRef.current;
        if (ta && res.length > 0) {
          const c = caretCoordinates(ta, cursor);
          // Anchor just below the caret line (vertical only); full-width horizontally.
          setAcTop(c.top - ta.scrollTop + c.height + 2);
        }
      } catch {
        setSuggestions([]);
      }
    }, 160);
  }

  function applyTag(tag: string) {
    const ta = taRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? value.length;
    const { start } = wordAtCursor(value, cursor);
    // Extend forward to cover the rest of any partial word
    let end = cursor;
    while (end < value.length && /[\w-]/.test(value[end])) end++;
    const after = value.slice(end).replace(/^\s*,\s*/, "").trimStart();
    const before = value.slice(0, start);
    const newVal = before + tag + ", " + after;
    onChange(newVal);
    clearSuggestions();
    const pos = start + tag.length + 2;
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(pos, pos); });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || composingRef.current) return;
    if (!suggestions.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyTag(suggestions[activeIdx].tag); }
    else if (e.key === "Escape") { clearSuggestions(); }
  }

  return (
    <div className="prompt-ac-wrap">
      <textarea
        ref={taRef}
        className={clsx("prompt-box", className)}
        aria-label={ariaLabel}
        rows={rows}
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
          clearSuggestions();
          if (timerRef.current) clearTimeout(timerRef.current);
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          handleChange(event as unknown as ChangeEvent<HTMLTextAreaElement>);
        }}
        onBlur={() => { if (timerRef.current) clearTimeout(timerRef.current); setTimeout(clearSuggestions, 180); }}
      />
      {suggestions.length > 0 && (
        <div
          className={clsx("ac-dropdown", acTop != null && "ac-dropdown-caret")}
          style={acTop != null ? { top: acTop } : undefined}
        >
          {suggestions.map((s, i) => (
            <button
              key={s.tag}
              className={clsx("ac-item", i === activeIdx && "ac-active")}
              onMouseDown={(e) => { e.preventDefault(); applyTag(s.tag); }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className="ac-dot" style={{ background: CAT_COLOR[s.category] ?? "#94a3b8" }} />
              <span className="ac-main">
                <span className="ac-tag">{s.tag}</span>
                <span className="ac-desc">{tagDescription(s, language)}</span>
              </span>
              <span className="ac-meta">
                <span>{localizedCategoryLabel(s.category, language)}</span>
                <span>{fmtCount(s.count)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

