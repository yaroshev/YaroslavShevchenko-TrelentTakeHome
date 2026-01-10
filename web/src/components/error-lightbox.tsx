"use client";

import { useEffect } from "react";

type ErrorLightboxProps = {
  error: string;
  onRetry: () => void;
  onClose: () => void;
};

export function ErrorLightbox({ error, onRetry, onClose }: ErrorLightboxProps) {
  // Prevent body scroll when lightbox is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Blurred backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
      
      {/* Lightbox content */}
      <div
        className="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="text-lg leading-none">×</span>
        </button>

        <div className="mb-6">
          <h2 className="text-xl font-semibold text-destructive">Error</h2>
          <p className="mt-3 text-sm text-muted-foreground break-words leading-relaxed">
            {error}
          </p>
        </div>
        
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              onRetry();
              onClose();
            }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => {
              // Open support email or support page
              window.location.href = `mailto:support@trelent.com?subject=Conversion Error&body=${encodeURIComponent(`Error: ${error}\n\nPlease provide details about what you were trying to do when this error occurred.`)}`;
            }}
            className="rounded-md border border-blue-600 bg-transparent px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50"
          >
            Contact Support
          </button>
        </div>
      </div>
    </div>
  );
}
