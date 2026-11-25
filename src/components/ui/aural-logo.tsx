import React from "react";

interface TrovenLogoProps {
  size?: number;
  className?: string;
  variant?: "icon" | "full";
  alt?: string;
}

export function TrovenLogo({
  size = 32,
  className = "",
  variant,
  alt = "Troven logo",
}: TrovenLogoProps) {
  const isFull = variant === "full" || (!variant && size > 48);

  if (isFull) {
    return (
      <img
        src="/images/logo.png"
        alt={alt}
        className={`object-contain ${className}`}
        style={{ height: size > 48 ? 44 : size, width: "auto" }}
      />
    );
  }

  return (
    <img
      src="/images/logo-icon.png"
      alt={alt}
      className={`object-contain shrink-0 ${className}`}
      style={{ height: size, width: "auto", maxHeight: size }}
    />
  );
}

export const AuralLogo = TrovenLogo;
