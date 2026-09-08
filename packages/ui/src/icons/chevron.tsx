/**
 * The strip's back/forward chevrons, 16px, paths measured from the reference
 * console's `ChevronLeftIcon` / `ChevronRightIcon`. A filled path rather than a
 * stroked polyline, so the arrow keeps its weight when the button disables it
 * to the faint tone. Sized by the button's icon slot.
 */
export function ChevronIcon({ direction }: { readonly direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={PATH[direction]} />
    </svg>
  );
}

const PATH = {
  left: "M10.53033 11.4697C10.82322 11.7626 10.82322 12.2374 10.53033 12.5303C10.23744 12.8232 9.76256 12.8232 9.46967 12.5303L5.46967 8.53033C5.1793 8.23999 5.1764 7.77014 5.4632 7.47624L9.36581 3.47624C9.65508 3.17976 10.12991 3.17391 10.42639 3.46318C10.72287 3.75244 10.72872 4.22728 10.43946 4.52376L7.05417 7.99351L10.53033 11.4697Z",
  right:
    "M5.46967 11.4697C5.17678 11.7626 5.17678 12.2374 5.46967 12.5303C5.76256 12.8232 6.23744 12.8232 6.53033 12.5303L10.5303 8.53033C10.8207 8.23999 10.8236 7.77014 10.5368 7.47624L6.63419 3.47624C6.34492 3.17976 5.87009 3.17391 5.57361 3.46318C5.27713 3.75244 5.27128 4.22728 5.56054 4.52376L8.94583 7.99351L5.46967 11.4697Z",
} as const;
