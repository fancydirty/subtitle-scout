# Directory Browser & Scan Strategy Research

**Research Date**: 2026-08-06  
**Context**: User reported two issues after deleting and re-adding /media directory:
1. No automatic scan triggered after re-adding directory (relies on polling)
2. Directory picker UX problems: can't navigate back to root, shows all system directories at root level
3. Handling rapid user operations (add/delete directories) during scanning

User explicitly requested: "先调研有没有别人的成熟轮子，不要手搓" (research mature solutions first, don't hand-roll)

---

## 1. Directory Browser Components

### Mature React Libraries

**🌟 Chonky** (https://chonky.io/)
- Recreates native file browsing experience in React
- Full-featured file browser component
- Well-documented, actively maintained

**🌟 SVAR React File Manager** (https://svar.dev/react/filemanager/)
- Open-source with full TypeScript support
- Backend-agnostic: "Using the intuitive React API, you can easily integrate our File Manager component with any server-side backend"
- Dynamic folder loading: "optimized initial loading by rendering only top-level folders first. Folder contents are fetched dynamically as users navigate"
- Multiple layout options (list, tiles, split view)

**@cubone/react-file-manager** (npm)
- Open-source, user-friendly
- Drag-and-drop support
- Supports `initialPath` prop and `onFolderChange` callback
- Pattern for tracking current folder in React state:
  ```tsx
  const [path, setPath] = useState('/Documents')
  <FileManager 
    initialPath={path} 
    onFolderChange={setPath}
  />
  ```

**react-keyed-file-browser** (npm)
- Older but lightweight
- Simple API for basic file browsing

**Syncfusion React File Manager** (Commercial)
- Windows Explorer-like interface
- Feature-rich but requires license

### Key Pattern: Dynamic Server-Side Navigation

All mature solutions use the same pattern:
1. **Don't calculate commonRootStart** - let user browse freely from a true root
2. **Fetch on demand** - only load directory contents when user navigates into it
3. **Breadcrumb navigation** - allow going back to any parent level
4. **Filter system directories** - either don't show them, or mark them clearly

**Current Problem**:
- `RootsManager.tsx` calculates `startPath = commonRootStart(roots) || '/'`
- `DirBrowser.tsx` can't navigate above `startPath`
- Empty state shows all system directories (`/dev`, `/proc`, `/sys`, etc.)

**Recommended Fix**:
1. Replace `commonRootStart` logic with a fixed starting point (e.g., `/home`, `/Users`, or user-configurable)
2. Add server-side filtering to exclude system directories (`/dev`, `/proc`, `/sys`, `/tmp`, etc.)
3. Allow navigating to parent directories up to the configured root
4. Consider using Chonky or SVAR if building from scratch is too complex

---

## 2. Scan Triggering Strategy

### Industry Patterns: Plex, Sonarr, Radarr

**Plex**:
- Two options: "Update my library automatically" + "Run a partial scan when changes are detected"
- Partial scan uses filesystem watchers (inotify on Linux, kqueue on macOS)
- **Known issues**: Doesn't work reliably on network shares (SMB, NFS)
- Common recommendation: Disable auto-scan, use webhook triggers from Sonarr/Radarr

**Sonarr/Radarr Pattern**:
- Settings → Connect → Add Plex connection
- **Triggers partial scan** when import completes
- Sends webhook to Plex: `POST /library/sections/{id}/refresh?path=/specific/folder`
- Only scans the specific parent folder, not entire library

**plex_autoscan** (l3uddz/plex_autoscan on GitHub):
- Community tool to assist Sonarr/Radarr with Plex imports
- Creates web server to accept webhook requests
- Sends targeted scan request to Plex for **parent folder only**
- **Key feature**: `SERVER_SCAN_DELAY` - debounces scan requests
- "Plex will then only scan the parent folder (i.e. season folder for TV shows, movie folder for movies) of the media file (versus scanning the entire library folder)"

**Common Issues Found**:
- Sonarr sometimes triggers **full library scan** instead of partial (bug)
- During upgrades (delete old file → copy new file), Plex may lose metadata if scanned between delete and copy
- **Solution**: Debounce scan triggers to avoid scanning during transient states

---

## 3. Debouncing Strategies for Rapid Operations

### Research Findings

**Optimal Debounce Time** (from Medium articles):
- **200-500ms** for UI interactions (search, autocomplete)
- **300ms** is the sweet spot: "feels instant to the user but gives your system breathing room"
- **1-2 seconds** for filesystem operations (file watchers, directory changes)

**Pattern: Notification + Rescan** (Rust filesystem watching discussion):
> "Instead of relying on the notify events as a true record of what happened, use notify as a, well, notification that something changed, with an unreliable/imprecise hint of what it is that changed, then **scan (read the whole or part of the directory tree)**, and finally decide what to do from the current and previous state."

**Three-Stage Approach**:
1. **Debounce events** (1-2 seconds) - wait for calm
2. **Upon debounced event firing** - perform full rescan of affected directories
3. **Compare state** - diff previous scan results with current to determine actual changes

**Queue-Based Debouncing** (Inngest article):
> "Similar to the example mentioned above, background jobs are often triggered by user actions that save data. If a user saves the same data in quick succession, or perhaps the front-end implements auto-save, it is likely that multiple background jobs will be triggered. **Adding a debounce delay to your background job can make your system more efficient**."

**Key Insight from Build Tools** (Panex article):
> "A single Ctrl+S does not arrive as a single event, it appears as a short burst of raw filesystem operations"
- File watchers (fsnotify, chokidar, inotify) report low-level ops
- Multiple events for single logical operation
- **Debounce window**: typically 50ms for builds, longer for scans

---

## 4. Recommended Solution

### For Directory Browser UX

**Option A: Use Mature Library** (Recommended)
- Adopt **SVAR React File Manager** or **Chonky**
- Both support TypeScript, backend-agnostic, dynamic loading
- Saves time vs hand-rolling navigation logic
- Better UX out of the box

**Option B: Fix Current Implementation**
1. Replace `commonRootStart` with configurable root (e.g., `/home` on Linux, `/Users` on macOS)
2. Add server-side filter for system directories
3. Allow breadcrumb navigation to any parent up to root
4. Show helpful message when at root instead of listing `/dev`, `/proc`, etc.

### For Scan Triggering

**Recommended Pattern** (based on Sonarr/Radarr/plex_autoscan):

```typescript
// Pseudocode
const SCAN_DEBOUNCE_MS = 2000 // 2 seconds

let pendingScanPaths = new Set<string>()
let debounceTimer: NodeJS.Timeout | null = null

function requestScan(path: string) {
  pendingScanPaths.add(path)
  
  if (debounceTimer) clearTimeout(debounceTimer)
  
  debounceTimer = setTimeout(() => {
    const pathsToScan = Array.from(pendingScanPaths)
    pendingScanPaths.clear()
    
    // Trigger actual scan
    triggerLibraryScan(pathsToScan)
  }, SCAN_DEBOUNCE_MS)
}

function onRootAdded(rootPath: string) {
  requestScan(rootPath)
}

function onRootDeleted(rootPath: string) {
  // Cancel any pending scan for this path
  pendingScanPaths.delete(rootPath)
  
  // If this was the last pending path, clear debounce
  if (pendingScanPaths.size === 0 && debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}
```

**Key Principles**:
1. **Debounce at 2 seconds** - handles rapid add/delete operations
2. **Accumulate paths** - if user adds multiple directories, scan all at once
3. **Cancel on delete** - if directory deleted before debounce fires, remove from queue
4. **Idempotent scans** - if same path added multiple times, only scan once

**Additional Considerations**:
- If scan is already running when new directory added, either:
  - **Queue for next scan** (simpler, used by Plex)
  - **Interrupt and restart** (complex, avoid unless necessary)
- Show UI feedback: "Scan scheduled in 2s..." with countdown
- Allow manual "Scan Now" button to bypass debounce

---

## 5. Implementation Priority

**High Priority**:
1. ✅ **Debounce scan triggers** - solves "monkey actions" problem
2. ✅ **Auto-trigger scan on root add** - solves "no automatic scan" issue

**Medium Priority**:
3. **Improve directory browser UX** - either adopt library or fix current impl

**Low Priority**:
4. Filter system directories in browser (cosmetic issue)

---

## References

- Chonky: https://chonky.io/
- SVAR React File Manager: https://svar.dev/react/filemanager/
- plex_autoscan: https://github.com/l3uddz/plex_autoscan
- Inngest debouncing: https://www.inngest.com/blog/debouncing-in-queueing-systems-optimizing-efficiency-in-async-workflows
- Filesystem watching patterns: https://www.reddit.com/r/rust/comments/1h3pmyv/how_can_i_accurately_watch_for_createdeleteupdate/

---

## Next Steps

User to decide:
1. **Directory browser**: Keep current impl with fixes, or adopt SVAR/Chonky?
2. **Scan debounce**: Implement 2-second debounce with path accumulation?
3. **Manual trigger**: Add "Scan Now" button to bypass debounce?
