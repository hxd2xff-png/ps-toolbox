# Photoshop Font Mixer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Photoshop 2019+ CEP plugin that contains only font mixing, native Photoshop color picking, and Photoshop Optical Kerning.

**Architecture:** Keep the existing Figma plugin unchanged. Add a self-contained `com.figmatoolbox.ps` CEP extension with a lightweight HTML panel and an ExtendScript host bridge. The host enumerates all selected text layers, applies each layer independently, and uses Action Manager text ranges only where Photoshop DOM cannot express mixed ranges.

**Tech Stack:** CEP 9-compatible HTML/CSS/JavaScript, ExtendScript ES3, Photoshop DOM and Action Manager.

## Global Constraints

- Support Photoshop 2019 (20.x) and newer; do not depend on UXP APIs whose documented minimum is 24.1.
- Apply operations to every selected text layer; one layer failure must not stop the remaining layers.
- Do not create documents, tabs, or temporary files during plugin startup.
- Load the font list only when the user opens/requests it; startup must remain responsive.
- Use Photoshop's native color picker for both color controls.
- Automatic fine adjustment must use Photoshop Optical Kerning, not custom symbol-pair tracking.

## Tasks

1. Add CEP manifest, panel, and host bridge with lazy initialization.
2. Implement multi-layer font mixing and text-range writes in ExtendScript.
3. Implement native color picker and Optical Kerning actions.
4. Add build/package documentation and static checks.

