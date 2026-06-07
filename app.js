/* ================================================================
   VocabApp — 背单词应用
   SM-2 间隔重复算法 + 闪卡 + 选择题 + 自定义导入
   ================================================================ */

// ─── 工具函数 ────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const today = () => new Date().toISOString().slice(0, 10);

// ─── SM-2 间隔重复算法 ────────────────────────────────────
const SM2 = {
  // 根据评分更新单词的复习参数
  // score: 0-5 (0=完全忘记, 5=秒懂)
  update(word, score) {
    const w = { ...word };
    w.reviewCount = (w.reviewCount || 0) + 1;

    if (score >= 3) {
      w.correctCount = (w.correctCount || 0) + 1;
      w.repetitions = (w.repetitions || 0) + 1;

      if (w.repetitions === 1) {
        w.interval = 1;
      } else if (w.repetitions === 2) {
        w.interval = 6;
      } else {
        w.interval = Math.round((w.interval || 0) * (w.ease || 2.5));
      }
    } else {
      w.repetitions = 0;
      w.interval = 0;
    }

    // 更新难度系数
    let ease = w.ease || 2.5;
    ease = ease + (0.1 - (5 - score) * (0.08 + (5 - score) * 0.02));
    if (ease < 1.3) ease = 1.3;
    w.ease = Math.round(ease * 100) / 100;

    // 下次复习日期
    const d = new Date();
    d.setDate(d.getDate() + w.interval);
    w.nextReview = d.toISOString().slice(0, 10);

    return w;
  },

  // 获取掌握程度标签
  getLevel(word) {
    const reps = word.repetitions || 0;
    const ease = word.ease || 2.5;
    if (reps >= 3 && ease >= 2.5) return { label: '已掌握', cls: 'mastered' };
    if (reps >= 1) return { label: '学习中', cls: 'learning' };
    return { label: '新词', cls: 'new' };
  }
};

// ─── 数据存储 ─────────────────────────────────────────────
class WordStore {
  constructor() {
    this.words = [];
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem('vocabapp-words');
      this.words = raw ? JSON.parse(raw) : [];
    } catch {
      this.words = [];
    }
  }

  save() {
    localStorage.setItem('vocabapp-words', JSON.stringify(this.words));
  }

  getAll() { return [...this.words]; }

  getDue() {
    const t = today();
    return this.words.filter(w => w.nextReview <= t);
  }

  getById(id) { return this.words.find(w => w.id === id); }

  add(word, definition, example = '') {
    const now = new Date().toISOString();
    const w = {
      id: crypto.randomUUID(),
      word: word.trim(),
      definition: definition.trim(),
      example: example.trim(),
      ease: 2.5,
      interval: 0,
      repetitions: 0,
      nextReview: today(),
      createdAt: now,
      updatedAt: now,
      reviewCount: 0,
      correctCount: 0
    };
    this.words.push(w);
    this.save();
    syncModule.schedulePush();
    return w;
  }

  update(id, data) {
    const idx = this.words.findIndex(w => w.id === id);
    if (idx === -1) return null;
    this.words[idx] = { ...this.words[idx], ...data, updatedAt: new Date().toISOString() };
    this.save();
    syncModule.schedulePush();
    return this.words[idx];
  }

  delete(id) {
    this.words = this.words.filter(w => w.id !== id);
    this.save();
    syncModule.schedulePush();
  }

  // 导入单词列表，自动去重
  importWords(list) {
    const existing = new Set(this.words.map(w => w.word.toLowerCase()));
    let added = 0, skipped = 0;
    const preview = [];

    for (const item of list) {
      const key = item.word.trim().toLowerCase();
      if (existing.has(key)) {
        skipped++;
        preview.push({ ...item, status: 'dup' });
      } else {
        preview.push({ ...item, status: 'new' });
      }
    }

    return { preview, added: preview.filter(p => p.status === 'new').length, skipped };
  }

  // 确认导入（仅导入新词）
  confirmImport(list) {
    const existing = new Set(this.words.map(w => w.word.toLowerCase()));
    let count = 0;
    for (const item of list) {
      if (!existing.has(item.word.trim().toLowerCase())) {
        this.add(item.word, item.definition, item.example || '');
        existing.add(item.word.trim().toLowerCase());
        count++;
      }
    }
    return count;
  }

  exportJSON() {
    return JSON.stringify(this.words, null, 2);
  }

  // 统计
  getStats() {
    const t = today();
    const due = this.words.filter(w => w.nextReview <= t).length;
    const mastered = this.words.filter(w => (w.repetitions || 0) >= 3 && (w.ease || 2.5) >= 2.5).length;
    return { total: this.words.length, due, mastered };
  }
}

// ─── 全局实例 ─────────────────────────────────────────────
const store = new WordStore();

// ─── 闪卡学习视图 ─────────────────────────────────────────
class FlashcardView {
  constructor() {
    this.words = [];
    this.currentIdx = 0;
    this.doneCount = 0;
    this.flipped = false;

    this.cardContainer = $('#card-container');
    this.flashcard = $('#flashcard');
    this.cardWord = $('#card-word');
    this.cardDefinition = $('#card-definition');
    this.cardExample = $('#card-example');
    this.cardMeta = $('#card-meta');
    this.ratingArea = $('#rating-area');
    this.emptyState = $('#study-empty');
    this.dueCountEl = $('#due-count');
    this.doneCountEl = $('#done-count');
    this.progressBar = $('#study-progress');

    this._bindEvents();
  }

  _bindEvents() {
    // 点击卡片翻转
    this.flashcard.addEventListener('click', () => this.flip());

    // 评分按钮
    $$('.rate-btn', this.ratingArea).forEach(btn => {
      btn.addEventListener('click', () => {
        const score = parseInt(btn.dataset.score);
        this.rate(score);
      });
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (!$('#panel-study').classList.contains('active')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        this.flip();
      }
      if (this.flipped && e.key >= '0' && e.key <= '5') {
        e.preventDefault();
        this.rate(parseInt(e.key));
      }
    });
  }

  load() {
    this.words = store.getDue();
    this.currentIdx = 0;
    this.doneCount = 0;
    this.flipped = false;
    this._updateStats();
    this._render();
  }

  _updateStats() {
    const dueTotal = this.words.length;
    this.dueCountEl.textContent = dueTotal;
    this.doneCountEl.textContent = this.doneCount;

    const pct = dueTotal > 0 ? Math.round((this.doneCount / dueTotal) * 100) : 0;
    this.progressBar.style.width = pct + '%';
  }

  _render() {
    if (this.currentIdx >= this.words.length) {
      // 全部复习完
      this.cardContainer.style.display = 'none';
      this.ratingArea.style.display = 'none';
      this.emptyState.style.display = 'block';
      this.dueCountEl.textContent = '0';
      this.doneCountEl.textContent = this.doneCount;
      this.progressBar.style.width = '100%';
      return;
    }

    this.cardContainer.style.display = 'block';
    this.ratingArea.style.display = 'none';
    this.emptyState.style.display = 'none';

    const word = this.words[this.currentIdx];
    this.cardWord.textContent = word.word;
    this.cardDefinition.textContent = word.definition;
    this.cardExample.textContent = word.example || '';
    this.cardMeta.textContent = `复习 ${word.reviewCount || 0} 次 · 连续正确 ${word.repetitions || 0} 次`;

    this.flashcard.classList.remove('flipped');
    this.flipped = false;
    this._updateStats();
  }

  flip() {
    if (this.flipped) return;
    this.flashcard.classList.add('flipped');
    this.flipped = true;
    this.ratingArea.style.display = 'block';
  }

  rate(score) {
    if (!this.flipped) return;
    const word = this.words[this.currentIdx];
    const updated = SM2.update(word, score);
    store.update(word.id, updated);
    this.doneCount++;
    this.currentIdx++;
    this.flipped = false;
    this._render();
    // 更新底部状态栏
    updateFooter();
  }
}

// ─── 选择题测验视图 ───────────────────────────────────────
class QuizView {
  constructor() {
    this.words = [];
    this.currentIdx = 0;
    this.score = 0;
    this.wrongWords = [];
    this.totalQuestions = 10;
    this.answered = false;

    this.quizActive = $('#quiz-active');
    this.quizResult = $('#quiz-result');
    this.quizEmpty = $('#quiz-empty');
    this.quizWord = $('#quiz-word');
    this.quizOptions = $('#quiz-options');
    this.quizFeedback = $('#quiz-feedback');
    this.quizCurrent = $('#quiz-current');
    this.quizTotal = $('#quiz-total');
    this.quizScore = $('#quiz-score');

    this._bindEvents();
  }

  _bindEvents() {
    $('#quiz-retry').addEventListener('click', () => this.start());
  }

  start() {
    const all = store.getAll();
    if (all.length < 4) {
      this.quizActive.style.display = 'none';
      this.quizResult.style.display = 'none';
      this.quizEmpty.style.display = 'block';
      return;
    }

    // 随机选词（优先选需要复习的）
    const due = store.getDue();
    const pool = due.length >= 4 ? due : all;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    this.words = shuffled.slice(0, Math.min(this.totalQuestions, pool.length));
    this.currentIdx = 0;
    this.score = 0;
    this.wrongWords = [];
    this.answered = false;

    this.quizActive.style.display = 'block';
    this.quizResult.style.display = 'none';
    this.quizEmpty.style.display = 'none';
    this.quizTotal.textContent = this.words.length;
    this.quizScore.textContent = '0';
    this.quizFeedback.textContent = '';
    this.quizFeedback.className = 'quiz-feedback';

    this._renderQuestion();
  }

  _renderQuestion() {
    if (this.currentIdx >= this.words.length) {
      this._showResult();
      return;
    }

    this.answered = false;
    const word = this.words[this.currentIdx];
    this.quizCurrent.textContent = this.currentIdx + 1;
    this.quizScore.textContent = this.score;
    this.quizFeedback.textContent = '';
    this.quizFeedback.className = 'quiz-feedback';
    this.quizWord.textContent = word.word;

    // 生成选项：1个正确 + 3个随机错误
    const all = store.getAll();
    const others = all.filter(w => w.id !== word.id);
    const shuffledOthers = [...others].sort(() => Math.random() - 0.5);
    const wrongOpts = shuffledOthers.slice(0, 3);

    // 如果不够3个错误选项
    while (wrongOpts.length < 3) {
      wrongOpts.push({ definition: '——' });
    }

    const options = [
      { text: word.definition, correct: true },
      ...wrongOpts.map(w => ({ text: w.definition, correct: false }))
    ].sort(() => Math.random() - 0.5);

    this.quizOptions.innerHTML = options.map((opt, i) =>
      `<button class="quiz-option" data-index="${i}" data-correct="${opt.correct}">${opt.text}</button>`
    ).join('');

    // 绑定点击
    $$('.quiz-option', this.quizOptions).forEach(btn => {
      btn.addEventListener('click', () => this._answer(btn));
    });
  }

  _answer(btn) {
    if (this.answered) return;
    this.answered = true;

    const isCorrect = btn.dataset.correct === 'true';
    const word = this.words[this.currentIdx];

    // 高亮所有选项
    $$('.quiz-option', this.quizOptions).forEach(b => {
      b.classList.add('disabled');
      if (b.dataset.correct === 'true') b.classList.add('correct');
    });

    if (isCorrect) {
      this.score++;
      this.quizScore.textContent = this.score;
      this.quizFeedback.textContent = '✅ 正确！';
      this.quizFeedback.className = 'quiz-feedback correct';
      btn.classList.add('correct');
      // 答对也算一次复习
      const updated = SM2.update(word, 4);
      store.update(word.id, updated);
    } else {
      btn.classList.add('wrong');
      this.quizFeedback.textContent = `❌ 正确答案：${word.definition}`;
      this.quizFeedback.className = 'quiz-feedback wrong';
      this.wrongWords.push(word);
      // 答错重置复习进度
      const updated = SM2.update(word, 0);
      store.update(word.id, updated);
    }

    // 延迟进入下一题
    setTimeout(() => {
      this.currentIdx++;
      this._renderQuestion();
    }, 1200);
  }

  _showResult() {
    this.quizActive.style.display = 'none';
    this.quizResult.style.display = 'block';

    const total = this.words.length;
    const pct = Math.round((this.score / total) * 100);

    $('#result-score').textContent = this.score;
    $('#result-total').textContent = total;

    let icon = '🎉';
    if (pct < 50) icon = '😅';
    else if (pct < 80) icon = '👍';
    else if (pct < 100) icon = '🌟';
    $('#result-icon').textContent = icon;

    if (this.wrongWords.length > 0) {
      $('#result-detail').innerHTML = `
        <p style="margin-bottom:8px;color:var(--gray-500);">需要复习的单词：</p>
        ${this.wrongWords.map(w => `
          <div class="wrong-word"><strong>${w.word}</strong> — ${w.definition}</div>
        `).join('')}
      `;
    } else {
      $('#result-detail').innerHTML = '<p style="color:var(--success)">全部正确，太棒了！</p>';
    }

    updateFooter();
  }
}

// ─── 单词本视图 ───────────────────────────────────────────
class WordListView {
  constructor() {
    this.searchQuery = '';
    this.sortBy = 'createdAt';
    this.expandedId = null;

    this.wordlist = $('#wordlist');
    this.countEl = $('#wordlist-count');
    this.emptyEl = $('#wordlist-empty');
    this.searchInput = $('#search-input');
    this.sortSelect = $('#sort-select');

    this._bindEvents();
  }

  _bindEvents() {
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim().toLowerCase();
      this.render();
    });

    this.sortSelect.addEventListener('change', () => {
      this.sortBy = this.sortSelect.value;
      this.render();
    });

    $('#add-word-btn').addEventListener('click', () => Modal.open());
    $('#export-btn').addEventListener('click', () => this._export());
  }

  _export() {
    const json = store.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocabapp-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  render() {
    let words = store.getAll();

    // 搜索过滤
    if (this.searchQuery) {
      words = words.filter(w =>
        w.word.toLowerCase().includes(this.searchQuery) ||
        w.definition.includes(this.searchQuery)
      );
    }

    // 排序
    words.sort((a, b) => {
      switch (this.sortBy) {
        case 'nextReview': return a.nextReview.localeCompare(b.nextReview);
        case 'ease': return (b.ease || 2.5) - (a.ease || 2.5);
        case 'word': return a.word.localeCompare(b.word);
        case 'createdAt':
        default: return b.createdAt.localeCompare(a.createdAt);
      }
    });

    this.countEl.textContent = words.length;

    if (words.length === 0) {
      this.wordlist.innerHTML = '';
      this.emptyEl.style.display = 'block';
    } else {
      this.emptyEl.style.display = 'none';
      this.wordlist.innerHTML = words.map(w => this._renderItem(w)).join('');
      this._bindItemEvents();
    }
  }

  _renderItem(word) {
    const level = SM2.getLevel(word);
    const isDue = word.nextReview <= today();
    const dueLabel = isDue ? '<span class="due-today">🔔 待复习</span>' : `<span class="due-later">📅 ${word.nextReview}</span>`;

    return `
      <div class="word-item ${level.cls}" data-id="${word.id}">
        <div class="word-item-header">
          <span class="word-item-word">${word.word}</span>
          <span style="font-size:12px;color:var(--gray-400);">${level.label}</span>
        </div>
        <div class="word-item-definition">${word.definition}</div>
        <div class="word-item-meta">
          ${dueLabel}
          <span>复习 ${word.reviewCount || 0} 次</span>
          <span>难度 ${word.ease || 2.5}</span>
        </div>
        <div class="word-item-detail">
          ${word.example ? `<div style="margin-bottom:8px;color:var(--gray-500);font-style:italic;">「${word.example}」</div>` : ''}
          <div class="word-item-actions">
            <button class="btn btn-outline btn-sm edit-btn" data-id="${word.id}">✏️ 编辑</button>
            <button class="btn btn-danger btn-sm delete-btn" data-id="${word.id}">🗑 删除</button>
          </div>
        </div>
      </div>
    `;
  }

  _bindItemEvents() {
    // 点击展开详情
    $$('.word-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // 不拦截按钮点击
        if (e.target.closest('button')) return;
        item.classList.toggle('expanded');
      });
    });

    // 编辑按钮
    $$('.edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const word = store.getById(id);
        if (word) Modal.open(word);
      });
    });

    // 删除按钮
    $$('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const word = store.getById(id);
        if (word && confirm(`确定删除「${word.word}」吗？此操作不可恢复。`)) {
          store.delete(id);
          this.render();
          updateFooter();
        }
      });
    });
  }
}

// ─── 导入视图 ─────────────────────────────────────────────
class ImportView {
  constructor() {
    this.previewData = [];
    this.previewList = $('#preview-list');
    this.previewPanel = $('#import-preview');
    this.previewTotal = $('#preview-total');
    this.previewNew = $('#preview-new');
    this.previewDup = $('#preview-dup');
    this.dropZone = $('#drop-zone');
    this.csvInput = $('#csv-file-input');
    this.textArea = $('#text-import-area');
    this.textParseBtn = $('#text-parse-btn');

    this._bindEvents();
  }

  _bindEvents() {
    // CSV 导入标签切换
    $$('.import-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.import-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.import-panel').forEach(p => p.classList.remove('active'));
        $('#import-' + btn.dataset.import).classList.add('active');
      });
    });

    // 拖拽上传
    this.dropZone.addEventListener('click', () => this.csvInput.click());
    this.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); this.dropZone.classList.add('drag-over'); });
    this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('drag-over'));
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) this._parseCSV(file);
    });

    this.csvInput.addEventListener('change', () => {
      const file = this.csvInput.files[0];
      if (file) this._parseCSV(file);
    });

    // 文本解析
    this.textParseBtn.addEventListener('click', () => {
      const text = this.textArea.value.trim();
      if (!text) return;
      this._parseText(text);
    });

    // 确认 / 取消导入
    $('#import-confirm').addEventListener('click', () => this._confirm());
    $('#import-cancel').addEventListener('click', () => {
      this.previewPanel.style.display = 'none';
      this.previewData = [];
    });
  }

  _parseCSV(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      const words = [];

      for (const line of lines) {
        // 智能分割：支持逗号、制表符
        const parts = this._splitLine(line);
        if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
          words.push({
            word: parts[0].trim(),
            definition: parts[1].trim(),
            example: parts[2] ? parts[2].trim() : ''
          });
        }
      }

      if (words.length > 0) this._showPreview(words);
    };
    reader.readAsText(file, 'UTF-8');
  }

  _parseText(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const words = [];

    for (const line of lines) {
      // 支持 "word - definition" 或 "word,definition"
      const parts = this._splitLine(line);
      if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
        words.push({
          word: parts[0].trim(),
          definition: parts[1].trim(),
          example: parts[2] ? parts[2].trim() : ''
        });
      }
    }

    if (words.length > 0) {
      this._showPreview(words);
    } else {
      alert('未能解析到有效单词，请检查格式。\n支持格式：单词 - 释义 或 单词,释义');
    }
  }

  _splitLine(line) {
    // 先尝试用 " - " 分割
    if (line.includes(' - ')) {
      return line.split(' - ');
    }
    // 尝试用制表符
    if (line.includes('\t')) {
      return line.split('\t');
    }
    // 最后用逗号
    return line.split(',');
  }

  _showPreview(words) {
    const result = store.importWords(words);
    this.previewData = result.preview;

    this.previewTotal.textContent = result.preview.length;
    this.previewNew.textContent = result.added;
    this.previewDup.textContent = result.skipped;

    this.previewList.innerHTML = result.preview.map(p => `
      <div class="preview-item ${p.status === 'dup' ? 'duplicate' : ''}">
        <span class="word-col">${p.word}</span>
        <span class="def-col">${p.definition}</span>
        <span class="tag ${p.status === 'new' ? 'new' : 'dup'}">${p.status === 'new' ? '新词' : '重复'}</span>
      </div>
    `).join('');

    this.previewPanel.style.display = 'block';
    this.previewPanel.scrollIntoView({ behavior: 'smooth' });
  }

  _confirm() {
    const newWords = this.previewData.filter(p => p.status === 'new');
    if (newWords.length === 0) {
      this.previewPanel.style.display = 'none';
      return;
    }

    const count = store.confirmImport(newWords);
    alert(`成功导入 ${count} 个新单词！`);
    this.previewPanel.style.display = 'none';
    this.previewData = [];
    this.csvInput.value = '';
    this.textArea.value = '';
    updateFooter();

    // 通知单词本刷新
    if (wordListView) wordListView.render();
  }
}

// ─── 弹窗（添加/编辑单词）─────────────────────────────────
class ModalController {
  constructor() {
    this.overlay = $('#word-modal');
    this.editingId = null;

    this._bindEvents();
  }

  _bindEvents() {
    $('#modal-cancel').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    $('#modal-save').addEventListener('click', () => this._save());

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay.classList.contains('active')) {
        this.close();
      }
    });
  }

  open(word = null) {
    this.editingId = word ? word.id : null;
    $('#modal-title').textContent = word ? '编辑单词' : '添加单词';
    $('#form-word').value = word ? word.word : '';
    $('#form-definition').value = word ? word.definition : '';
    $('#form-example').value = word ? (word.example || '') : '';
    $('#form-id').value = word ? word.id : '';
    this.overlay.classList.add('active');
    setTimeout(() => $('#form-word').focus(), 100);
  }

  close() {
    this.overlay.classList.remove('active');
    this.editingId = null;
  }

  _save() {
    const id = $('#form-id').value;
    const wordVal = $('#form-word').value.trim();
    const defVal = $('#form-definition').value.trim();
    const exampleVal = $('#form-example').value.trim();

    if (!wordVal || !defVal) {
      alert('单词和释义不能为空');
      return;
    }

    if (id) {
      store.update(id, { word: wordVal, definition: defVal, example: exampleVal });
    } else {
      store.add(wordVal, defVal, exampleVal);
    }

    this.close();
    wordListView.render();
    updateFooter();
  }
}

// ─── 更新底部状态栏 ───────────────────────────────────────
function updateFooter() {
  const stats = store.getStats();
  $('#footer-total').textContent = stats.total;
  $('#footer-mastered').textContent = stats.mastered;
  $('#footer-due').textContent = stats.due;

  // 更新同步状态图标
  if (syncModule.isConfigured()) {
    syncModule._setStatus('synced');
  } else {
    syncModule._setStatus('unset');
  }
}

// ─── Tab 切换 ─────────────────────────────────────────────
function setupTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;

      // 切换按钮状态
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // 切换面板
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      $(`#panel-${tab}`).classList.add('active');

      // 切换到对应面板时刷新数据
      if (tab === 'study') flashcardView.load();
      if (tab === 'quiz') quizView.start();
      if (tab === 'wordlist') wordListView.render();
    });
  });
}

// ─── 云同步模块 ────────────────────────────────────────────
class SyncModule {
  constructor() {
    this.token = localStorage.getItem('vocabapp-sync-token') || '';
    this.repo = localStorage.getItem('vocabapp-sync-repo') || 'Au-Y/vocab-app';
    this.autoSync = localStorage.getItem('vocabapp-sync-auto') !== 'false';
    this.pushTimer = null;
    this._statusEl = null;
  }

  // 调度延迟推送（防抖 2 秒）
  schedulePush() {
    if (!this.token || !this.autoSync) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push(), 2000);
  }

  // 更新状态指示器
  _setStatus(status) {
    const el = this._statusEl || $('#sync-status');
    this._statusEl = el;
    if (!el) return;
    el.className = 'sync-status ' + status;
    const icons = { synced: '☁️', syncing: '🔄', error: '⚠️', unset: '☁️' };
    const titles = { synced: '已同步', syncing: '同步中...', error: '同步失败，点击设置', unset: '点击设置云同步' };
    el.textContent = icons[status] || icons.unset;
    el.title = titles[status] || titles.unset;
  }

  // 检查是否已配置
  isConfigured() { return !!this.token; }

  // 保存配置
  configure(token, repo, autoSync) {
    this.token = token;
    this.repo = repo || 'Au-Y/vocab-app';
    this.autoSync = autoSync;
    localStorage.setItem('vocabapp-sync-token', token);
    localStorage.setItem('vocabapp-sync-repo', this.repo);
    localStorage.setItem('vocabapp-sync-auto', autoSync ? 'true' : 'false');
    this._setStatus('synced');
  }

  // 构建 API URL
  _apiUrl() {
    return `https://api.github.com/repos/${this.repo}/contents/data/words.json`;
  }

  // 拉取远程数据
  async pull() {
    if (!this.token) {
      this._log('请先设置 GitHub Token', 'error');
      return null;
    }

    this._setStatus('syncing');
    this._log('正在拉取...');

    try {
      const resp = await fetch(this._apiUrl(), {
        headers: { Authorization: `token ${this.token}`, Accept: 'application/vnd.github.v3+json' }
      });

      if (!resp.ok) {
        if (resp.status === 404) {
          this._log('远程暂无数据', 'success');
          this._setStatus('synced');
          return [];
        }
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      // GitHub API 返回的 content 是 base64 编码的
      const content = JSON.parse(atob(data.content.replace(/\n/g, '')));
      this._sha = data.sha;
      this._log('拉取成功', 'success');
      this._setStatus('synced');
      return content;
    } catch (err) {
      this._log('拉取失败: ' + err.message, 'error');
      this._setStatus('error');
      return null;
    }
  }

  // 推送本地数据到远程
  async push() {
    if (!this.token) return;

    this._setStatus('syncing');

    try {
      // 先获取最新的 SHA
      let sha = this._sha;
      try {
        const resp = await fetch(this._apiUrl(), {
          headers: { Authorization: `token ${this.token}`, Accept: 'application/vnd.github.v3+json' }
        });
        if (resp.ok) {
          const data = await resp.json();
          sha = data.sha;
        }
      } catch {}

      const content = btoa(unescape(encodeURIComponent(JSON.stringify(store.words, null, 2))));

      const putResp = await fetch(this._apiUrl(), {
        method: 'PUT',
        headers: {
          Authorization: `token ${this.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `Sync: ${store.words.length} words [${new Date().toLocaleString('zh-CN')}]`,
          content: content,
          sha: sha
        })
      });

      if (!putResp.ok) {
        const err = await putResp.json();
        throw new Error(err.message || `HTTP ${putResp.status}`);
      }

      const data = await putResp.json();
      this._sha = data.content.sha;
      this._setStatus('synced');
    } catch (err) {
      this._log('推送失败: ' + err.message, 'error');
      this._setStatus('error');
    }
  }

  // 合并远程和本地数据（按 updatedAt 时间戳，新者胜）
  merge(localWords, remoteWords) {
    if (!remoteWords || remoteWords.length === 0) return localWords;

    const localMap = new Map(localWords.map(w => [w.id, w]));
    const remoteMap = new Map(remoteWords.map(w => [w.id, w]));

    // 远程有但本地没有的 → 加入本地
    for (const [id, rw] of remoteMap) {
      if (!localMap.has(id)) {
        localMap.set(id, rw);
      } else {
        // 两边都有 → 比较 updatedAt，保留新的
        const lw = localMap.get(id);
        const lt = lw.updatedAt || lw.createdAt || '';
        const rt = rw.updatedAt || rw.createdAt || '';
        if (rt > lt) {
          localMap.set(id, rw);
        }
      }
    }

    // 本地有但远程没有的 → 保留（推送时会同步过去）
    return [...localMap.values()];
  }

  // 完整同步流程
  async syncNow() {
    if (!this.token) return;

    const remote = await this.pull();
    if (remote !== null) {
      store.words = this.merge(store.words, remote);
      store.save();
      wordListView.render();
      updateFooter();
      await this.push();
    }
  }

  _log(msg, type) {
    const el = $('#sync-log');
    if (el) {
      el.textContent = msg;
      el.className = 'sync-log ' + (type || '');
    }
  }
}

// ─── 全局实例 ─────────────────────────────────────────────
const syncModule = new SyncModule();
const flashcardView = new FlashcardView();
const quizView = new QuizView();
const wordListView = new WordListView();
const importView = new ImportView();
const Modal = new ModalController();

// ─── Service Worker 注册 ─────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        console.log('SW registered:', reg.scope);
        // 检测更新
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // 有新版本可用，提示用户
              const update = confirm('有新版本可用，是否刷新？');
              if (update) window.location.reload();
            }
          });
        });
      })
      .catch((err) => console.log('SW registration failed:', err));
  }
}

// ─── 同步设置 UI ──────────────────────────────────────────
function setupSyncUI() {
  const modal = $('#sync-modal');
  const tokenInput = $('#sync-token');
  const repoInput = $('#sync-repo');
  const autoCheck = $('#sync-auto');
  const logEl = $('#sync-log');

  // 打开同步设置
  $('#sync-status').addEventListener('click', () => {
    tokenInput.value = syncModule.token;
    repoInput.value = syncModule.repo;
    autoCheck.checked = syncModule.autoSync;
    logEl.textContent = '';
    modal.classList.add('active');
  });

  // 关闭
  const closeModal = () => modal.classList.remove('active');
  $('#sync-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
  });

  // 保存配置
  $('#sync-save').addEventListener('click', () => {
    const token = tokenInput.value.trim();
    const repo = repoInput.value.trim() || 'Au-Y/vocab-app';
    const auto = autoCheck.checked;
    syncModule.configure(token, repo, auto);
    closeModal();
    // 配置后立即同步
    syncModule.syncNow();
  });

  // 手动拉取
  $('#sync-pull-btn').addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) { syncModule._log('请先输入 Token', 'error'); return; }
    syncModule.configure(token, repoInput.value.trim(), autoCheck.checked);
    const remote = await syncModule.pull();
    if (remote !== null) {
      store.words = syncModule.merge(store.words, remote);
      store.save();
      wordListView.render();
      updateFooter();
      syncModule._log(`拉取完成，共 ${store.words.length} 个单词`, 'success');
    }
  });

  // 手动推送
  $('#sync-push-btn').addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) { syncModule._log('请先输入 Token', 'error'); return; }
    syncModule.configure(token, repoInput.value.trim(), autoCheck.checked);
    await syncModule.push();
    syncModule._log(`推送完成，共 ${store.words.length} 个单词`, 'success');
  });
}

// ─── 启动应用 ─────────────────────────────────────────────
async function init() {
  setupTabs();
  setupSyncUI();
  updateFooter();

  // 如果已配置同步，启动时自动拉取合并
  if (syncModule.isConfigured()) {
    const remote = await syncModule.pull();
    if (remote !== null && remote.length > 0) {
      store.words = syncModule.merge(store.words, remote);
      store.save();
    }
  }

  wordListView.render();
  flashcardView.load();
  registerSW();
}

// 页面加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
