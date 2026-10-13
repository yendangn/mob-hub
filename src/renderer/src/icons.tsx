/** Line icons on one 24×24 grid, so that every icon button has the same size and stroke. */
const PATHS = {
  back: <path d="M17.5 4.5 6 12l11.5 7.5z" />,
  home: <circle cx="12" cy="12" r="7" />,
  recents: <rect x="5" y="5" width="14" height="14" rx="2" />,
  volDown: (
    <>
      <path d="M4 9h3l5-4v14l-5-4H4z" />
      <path d="M16 9.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  volUp: (
    <>
      <path d="M4 9h3l5-4v14l-5-4H4z" />
      <path d="M16 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M18.5 7a7 7 0 0 1 0 10" />
    </>
  ),
  rotate: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  camera: (
    <>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2h5.4l1.5 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  text: (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M8.5 8.5h7M12 8.5v7" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <path d="M18.88 9.87 21.36 10.39 21.36 13.61 18.88 14.13 18.37 15.36 19.76 17.48 17.48 19.76 15.36 18.37 14.13 18.88 13.61 21.36 10.39 21.36 9.87 18.88 8.64 18.37 6.52 19.76 4.24 17.48 5.63 15.36 5.12 14.13 2.64 13.61 2.64 10.39 5.12 9.87 5.63 8.64 4.24 6.52 6.52 4.24 8.64 5.63 9.87 5.12 10.39 2.64 13.61 2.64 14.13 5.12 15.36 5.63 17.48 4.24 19.76 6.52 18.37 8.64z" />
      <circle cx="12" cy="12" r="3" />
    </>
  )
} as const

type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
