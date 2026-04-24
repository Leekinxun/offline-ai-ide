import React from "react";

interface BrandMarkProps {
  size?: number;
  title?: string;
  subtitle?: string;
  stacked?: boolean;
  className?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({
  size = 20,
  title,
  subtitle,
  stacked = false,
  className = "",
}) => {
  const classes = ["brand-lockup", stacked ? "stacked" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <img
        src="/favicon.svg"
        alt="AI IDE"
        className="brand-mark-image"
        style={{ width: size, height: size }}
        draggable={false}
      />
      {(title || subtitle) && (
        <span className="brand-lockup-text">
          {title && <span className="brand-lockup-title">{title}</span>}
          {subtitle && <span className="brand-lockup-subtitle">{subtitle}</span>}
        </span>
      )}
    </div>
  );
};
