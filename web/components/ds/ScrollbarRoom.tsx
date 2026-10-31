"use client";

import { useEffect } from "react";

/**
 * backdrop-gutter: keeps --scrollbar-room on <html> at the width the page's scrollbar takes (its
 * gutter from 640 px; 0 where scrollbars float over the page, as on a Mac or a phone). While a
 * dialog's or sheet's backdrop ([data-backdrop]) is open, globals.css turns that room into
 * padding so the page stays put while the backdrop covers the whole window. Measured only while
 * none is open: then the scrollbar is gone and the room would read 0.
 */
export function ScrollbarRoom() {
  useEffect(() => {
    const html = document.documentElement;
    const measure = () => {
      if (html.matches(":has([data-backdrop])")) return;
      const room = Math.max(0, window.innerWidth - html.getBoundingClientRect().width);
      html.style.setProperty("--scrollbar-room", `${room}px`);
    };
    // The page's box narrows or widens whenever the scrollbar comes, goes or changes width.
    const observer = new ResizeObserver(measure);
    observer.observe(html);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return null;
}
