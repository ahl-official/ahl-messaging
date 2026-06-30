"use client";

// Shared animated modal wrapper. Fades the backdrop in and pops the
// panel with a subtle scale so every dialog opens consistently instead
// of snapping into place. Exit is left instant — call sites mount/unmount
// conditionally, so wrapping in AnimatePresence per dialog isn't worth it.

import { motion } from "motion/react";

export function ModalShell({
  children,
  overlayClassName,
  panelClassName,
  onOverlayClick,
}: {
  children: React.ReactNode;
  overlayClassName: string;
  panelClassName: string;
  onOverlayClick?: () => void;
}) {
  return (
    <motion.div
      className={overlayClassName}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      onClick={onOverlayClick}
    >
      <motion.div
        className={panelClassName}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
