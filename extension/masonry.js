/* Compact project cards without changing their sorted DOM or keyboard order. */
(() => {
  'use strict';

  function mount(board) {
    let frame = 0, disposed = false, lastHeight = 0;
    let cards = new Set();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;

    function clearPlacement(card) {
      card.style.gridColumn = '';
      card.style.gridRow = '';
    }

    function layout() {
      frame = 0;
      if (disposed || !board.isConnected) return;
      const minHeight = board.style.minHeight;
      // Keep the page's scroll range while measuring the temporary unplaced
      // grid. A background refresh must not jump a scrolled page to the top.
      if (lastHeight) board.style.minHeight = `${lastHeight}px`;
      // Old explicit column positions would create implicit columns after a
      // narrower resize. Remove them before reading the responsive track list.
      cards.forEach(clearPlacement);
      const style = getComputedStyle(board);
      // Keep the existing responsive CSS in charge of widths and column count.
      const columns = style.gridTemplateColumns.match(/[\d.]+px/g)?.length || 1;
      if (columns < 2 || !cards.size) {
        board.classList.remove('is-masonry');
        cards.forEach(clearPlacement);
        board.style.minHeight = minHeight;
        lastHeight = board.getBoundingClientRect().height;
        return;
      }
      board.classList.add('is-masonry');
      const gap = Math.max(0, Math.ceil(parseFloat(style.columnGap) || 0));
      const bottoms = Array(columns).fill(0);
      // Measure all intrinsic heights before writing placement styles. Cards
      // keep align-items:start, so their content never stretches to a row span.
      const measured = [...cards].map(card => [card, Math.max(1, Math.ceil(card.getBoundingClientRect().height))]);
      for (const [card, height] of measured) {
        const top = Math.min(...bottoms), column = bottoms.indexOf(top);
        card.style.gridColumn = String(column + 1);
        card.style.gridRow = `${top + 1} / span ${height}`;
        bottoms[column] = top + height + gap;
      }
      lastHeight = Math.max(...bottoms) - gap;
      board.style.minHeight = minHeight;
    }

    function schedule() {
      if (!disposed && !frame) frame = requestAnimationFrame(layout);
    }

    function update() {
      if (disposed) return;
      const next = new Set([...board.children].filter(child => child.classList.contains('project-card')));
      for (const card of cards) if (!next.has(card)) observer?.unobserve(card);
      for (const card of next) if (!cards.has(card)) observer?.observe(card);
      cards = next;
      schedule();
    }

    // Resizing the board, loading fonts or changing card text can alter column
    // heights without a new data snapshot. Coalesce those changes per frame.
    observer?.observe(board);
    globalThis.addEventListener('resize', schedule);
    document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    update();

    return {
      update,
      destroy() {
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        observer?.disconnect();
        globalThis.removeEventListener('resize', schedule);
        document.fonts?.removeEventListener('loadingdone', schedule);
        board.classList.remove('is-masonry');
        cards.forEach(clearPlacement);
        cards.clear();
      }
    };
  }

  globalThis.TaskOutMasonry = {mount};
})();
