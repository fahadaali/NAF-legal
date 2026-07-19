import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';

// أدوات قانونية مستقلّة: مقارنة نسختين + حاسبة المواعيد
export default function Tools() {
  const [tab, setTab] = useState<'compare' | 'deadlines'>('compare');
  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 style={{ fontSize: 24, marginTop: 0 }}>أدوات قانونية</h1>
        <div className="admin-tabs">
          <button className={`admin-tab ${tab === 'compare' ? 'active' : ''}`} onClick={() => setTab('compare')}>
            مقارنة نسختين
          </button>
          <button className={`admin-tab ${tab === 'deadlines' ? 'active' : ''}`} onClick={() => setTab('deadlines')}>
            حاسبة المواعيد
          </button>
        </div>
        {tab === 'compare' ? <Compare /> : <Deadlines />}
      </div>
    </div>
  );
}

function Compare() {
  const [ta, setTa] = useState('');
  const [tb, setTb] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const fa = useRef<HTMLInputElement>(null);
  const fb = useRef<HTMLInputElement>(null);

  const readFile = async (f: File, set: (s: string) => void) => {
    if (f.type.startsWith('text/') || f.name.endsWith('.txt')) set(await f.text());
    else set(`[سيُقرأ الملف: ${f.name} عند المقارنة]`); // للملفات الأخرى نعتمد الاستخراج الخادمي عبر النص المُدخل
  };

  const run = async () => {
    if (!ta.trim() || !tb.trim()) return alert('أدخل النسختين');
    setBusy(true);
    setResult('');
    try {
      const r = await api.compare(ta, tb);
      setResult(r.result);
    } catch (e: any) {
      alert(e.message ?? 'فشلت المقارنة');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p style={{ color: 'var(--muted)', fontSize: 14 }}>الصق نصّ النسختين (أو ارفع ملفات نصّية) لإبراز الفروق وأثرها القانوني.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <div className="field"><label>النسخة (أ)</label>
            <textarea className="tool-textarea" value={ta} onChange={(e) => setTa(e.target.value)} placeholder="النسخة الأولى…" />
          </div>
          <input ref={fa} type="file" hidden accept=".txt,.md" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], setTa)} />
          <button className="btn-sm" onClick={() => fa.current?.click()}>📎 رفع ملف نصّي</button>
        </div>
        <div>
          <div className="field"><label>النسخة (ب)</label>
            <textarea className="tool-textarea" value={tb} onChange={(e) => setTb(e.target.value)} placeholder="النسخة الثانية…" />
          </div>
          <input ref={fb} type="file" hidden accept=".txt,.md" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], setTb)} />
          <button className="btn-sm" onClick={() => fb.current?.click()}>📎 رفع ملف نصّي</button>
        </div>
      </div>
      <button className="btn-primary" style={{ marginTop: 14, width: 'auto', padding: '10px 24px' }} onClick={run} disabled={busy}>
        {busy ? 'جارٍ المقارنة…' : 'قارن النسختين'}
      </button>
      {result && <div className="msg-content" style={{ marginTop: 18 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(result) }} />}
    </div>
  );
}

function Deadlines() {
  const [form, setForm] = useState({ judgment_type: '', notification_date: '', court: '', notes: '' });
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!form.notification_date) return alert('أدخل تاريخ التبليغ');
    setBusy(true);
    setResult('');
    try {
      const r = await api.deadlines(form);
      setResult(r.result);
    } catch (e: any) {
      alert(e.message ?? 'فشل الحساب');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <p style={{ color: 'var(--muted)', fontSize: 14 }}>احسب مواعيد الاعتراض/الاستئناف النظامية بناءً على تاريخ التبليغ.</p>
      <div className="field"><label>نوع الحكم/القرار</label>
        <input value={form.judgment_type} onChange={(e) => setForm({ ...form, judgment_type: e.target.value })} placeholder="مثال: حكم ابتدائي في دعوى عمّالية" />
      </div>
      <div className="field"><label>الجهة/المحكمة</label>
        <input value={form.court} onChange={(e) => setForm({ ...form, court: e.target.value })} placeholder="مثال: المحكمة العمّالية" />
      </div>
      <div className="field"><label>تاريخ التبليغ</label>
        <input value={form.notification_date} onChange={(e) => setForm({ ...form, notification_date: e.target.value })} placeholder="مثال: 1447/01/15هـ أو 2025-07-10" />
      </div>
      <div className="field"><label>ملاحظات (اختياري)</label>
        <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <button className="btn-primary" style={{ width: 'auto', padding: '10px 24px' }} onClick={run} disabled={busy}>
        {busy ? 'جارٍ الحساب…' : 'احسب المواعيد'}
      </button>
      {result && <div className="msg-content" style={{ marginTop: 18 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(result) }} />}
    </div>
  );
}
