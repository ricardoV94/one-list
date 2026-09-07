// Build an isolated candidate; application code is only changed after benchmarking.
export function cachedPreviewCandidate(source) {
  const take=(start,end)=>{
    const a=source.indexOf(start), b=source.indexOf(end,a);
    if(a<0||b<0)throw Error('Candidate extraction failed: '+start);
    const code=source.slice(a,b);source=source.slice(0,a)+source.slice(b);return code;
  };
  const renderer=take('    const renderer = new marked.Renderer();','    const pendingCheckboxUpdates');
  const blocks=take('    const isBlank =','    // Map a click point');
  const imageStart=source.indexOf('    function resolveImageRefs(');
  const imageEnd=source.indexOf('\n    }',imageStart)+6;
  const image=source.slice(imageStart,imageEnd);
  source=source.slice(0,imageStart)+source.slice(imageEnd);
  const names='cleanHtml, applyTodoMarkup, isBlank, isFence, isListLine, isHeading, isQuote, splitBlocks, blockText, resolveImageRefs';
  source=source.replace('    const pendingCheckboxUpdates',`    const { ${names} } = window.__noteMarkup;\n    const pendingCheckboxUpdates`);
  const preview=`  <!-- Shared Markdown rendering has no Firebase dependency. The initial preview
       uses the same sanitizer and block parsing as the fully interactive notes. -->
  <script type="module" id="cached-note-preview">
${renderer}${blocks}${image}
    window.__noteMarkup = { ${names} };
    try {
      const remembered = localStorage.getItem('wasSignedIn');
      if (remembered) {
        const notes = JSON.parse(localStorage.getItem('notesCache') || '[]');
        if (Array.isArray(notes)) {
          // Transfer the parsed snapshot to the main module rather than reading
          // and parsing localStorage a second time when Firebase arrives.
          window.__bootNotes = notes;
          const email = remembered === '1' ? null : remembered;
          const preview = document.createElement('div');
          preview.id = 'boot-notes';
          preview.setAttribute('aria-label', 'Saved notes preview');
          const start = performance.now();
          for (const note of notes) {
            if (!note || typeof note.content !== 'string') continue;
            if (note.owner !== email && Array.isArray(note.hiddenFor) && note.hiddenFor.includes(email)) continue;
            const card = document.createElement('div');
            const rejected = note.owner === email && note.shared && Array.isArray(note.hiddenFor) && note.hiddenFor.length;
            const forked = (note.orphanVersions || []).some(id => !(note.resolvedVersions || []).includes(id));
            card.className = 'entry-card' + (rejected ? ' unlinked' : note.shared ? ' shared' : '') + (forked ? ' forked' : '');
            const content = document.createElement('div');
            content.className = 'entry-content';
            for (const block of splitBlocks(note.content)) {
              const div = document.createElement('div');
              div.className = 'md-block';
              div.innerHTML = cleanHtml(blockText(note.content, block), note.images);
              content.appendChild(div);
            }
            applyTodoMarkup(content);
            content.querySelectorAll('img').forEach(img => { img.loading = 'lazy'; });
            card.appendChild(content);
            preview.appendChild(card);
            // Just a first-screen preview; full hydration streams the remaining
            // notes with their controls. Do not block startup rendering the list twice.
            if (preview.children.length >= 6 || performance.now() - start > 12) break;
          }
          if (preview.children.length) {
            document.getElementById('entries-list').before(preview);
            document.getElementById('auth-section').style.display = 'none';
            document.getElementById('app').style.display = 'block';
            window.__bootMark('local:preview (' + preview.children.length + ')');
          }
        }
      }
    } catch (e) { /* Missing/corrupt cache: the normal startup path still runs. */ }
  </script>

`;
  source=source.replace('  <script type="module">',preview+'  <script type="module">');
  source=source.replace("      let raw; try { raw = localStorage.getItem('notesCache'); } catch (e) { return; }\n      if (!raw) return;\n      try {\n        const arr = JSON.parse(raw);",`      try {
        const arr = window.__bootNotes || JSON.parse(localStorage.getItem('notesCache') || 'null');
        delete window.__bootNotes;`);
  source=source.replace("        window.__bootMark('local:notes (' + allEntries.length + ')');","        document.getElementById('boot-notes')?.remove();\n        window.__bootMark('local:notes (' + allEntries.length + ')');");
  source=source.replace("        currentUserEmail = null;\n        localStorage.removeItem('wasSignedIn');", "        currentUserEmail = null;\n        document.getElementById('boot-notes')?.remove();\n        delete window.__bootNotes;\n        localStorage.removeItem('wasSignedIn');");
  return source;
}
