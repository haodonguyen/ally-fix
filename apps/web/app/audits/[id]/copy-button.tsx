"use client";

import { useState } from "react";
import styles from "./report.module.css";

/** A button that copies `text` to the clipboard and announces success politely. */
export function CopyButton({
  text,
  label,
  secondary = false,
}: {
  text: string;
  label: string;
  secondary?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context) — fail quietly.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`${styles.button} ${secondary ? styles.buttonSecondary : ""}`}
    >
      {copied ? "Copied" : label}
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
