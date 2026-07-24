import { BRANDING } from '../config/branding.js';

export default function CompanyLogo({ size = 48, showText = true }) {
  return (
    <div className="company-logo">
      <img
        src={BRANDING.logoSrc}
        alt={BRANDING.logoAlt}
        width={size}
        height={size}
        className="company-logo__img"
      />
      {showText && (
        <div className="company-logo__text">
          <strong>{BRANDING.companyName}</strong>
          <span>{BRANDING.appName}</span>
        </div>
      )}
    </div>
  );
}
