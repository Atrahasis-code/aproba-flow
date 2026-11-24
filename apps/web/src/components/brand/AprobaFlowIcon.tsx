'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface AprobaFlowIconProps {
  className?: string;
  decorative?: boolean;
  title?: string;
}

/**
 * Official vector brand mark for AprobaFlow combining an ascending "A" flow stroke
 * and an emerald approval checkmark inside a corporate blue squircle.
 */
export function AprobaFlowIcon({
  className,
  decorative = true,
  title = 'AprobaFlow',
}: AprobaFlowIconProps) {
  const rawId = React.useId();
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '') || 'af';
  const bgGradientId = `${safeId}-bg`;
  const checkGradientId = `${safeId}-check`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      className={cn('inline-block select-none', className)}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title}
    >
      {!decorative && <title>{title}</title>}
      <defs>
        <linearGradient
          id={bgGradientId}
          x1="6"
          y1="6"
          x2="58"
          y2="58"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="48%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#1e3a8a" />
        </linearGradient>
        <linearGradient
          id={checkGradientId}
          x1="25"
          y1="46"
          x2="50"
          y2="22"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#6ee7b7" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${bgGradientId})`} />
      <rect
        x="2.75"
        y="2.75"
        width="58.5"
        height="58.5"
        rx="14.25"
        stroke="#ffffff"
        strokeOpacity="0.18"
        strokeWidth="1.5"
      />
      <path
        d="M14 46L26 18L32.5 33"
        stroke="#ffffff"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M25.5 39L33 46.5L50 22"
        stroke={`url(#${checkGradientId})`}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
