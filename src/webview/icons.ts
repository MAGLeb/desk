const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  card: svg('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5 6.5h6M5 9.2h3.5"/>'),
  group: svg('<path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M11 2.5h1.5a1 1 0 0 1 1 1V5M13.5 11v1.5a1 1 0 0 1-1 1H11M5 13.5H3.5a1 1 0 0 1-1-1V11"/><path d="M5.5 6h5"/>'),
  minus: svg('<path d="M4 8h8"/>'),
  plus: svg('<path d="M8 4v8M4 8h8"/>'),
  fit: svg('<path d="M6 2.5H3.5a1 1 0 0 0-1 1V6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10"/><rect x="5.5" y="5.5" width="5" height="5" rx=".8"/>'),
  undo: svg('<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7"/>'),
  redo: svg('<path d="M10.5 3.5l3 3-3 3"/><path d="M13.5 6.5H6a3.5 3.5 0 0 0 0 7h3"/>'),
  pin: svg('<path d="M10.2 2.2l3.6 3.6-2.1.7-2.3 2.3.3 2.9-1.1 1.1-2.4-2.4-3.4 3.4M6.2 10.4 3.8 8l1.1-1.1 2.9.3 2.3-2.3.7-2.1"/>'),
  close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 8.6a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-8.6M6.8 7v4.5M9.2 7v4.5"/>'),
  file: svg('<path d="M9 1.8H4.3a.8.8 0 0 0-.8.8v10.8a.8.8 0 0 0 .8.8h7.4a.8.8 0 0 0 .8-.8V5.3z"/><path d="M9 1.8v3.5h3.5"/>'),
  link: svg('<path d="M6.6 9.4l2.8-2.8"/><path d="M7.3 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.7 11.4l-1 1A2.6 2.6 0 0 1 4 8.7l1-1"/>'),
};
