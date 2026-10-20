import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Button({ kind = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' }) {
  const look =
    kind === 'primary'
      ? 'bg-shu text-on-accent hover:brightness-110'
      : 'border border-line-strong text-ink hover:bg-raised';
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-bold transition disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kin ${look} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | undefined }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium tracking-[0.6px] text-muted uppercase">{label}</span>
      <input
        className="min-h-12 rounded-[10px] border border-line-strong bg-raised px-3 text-[15px] text-ink placeholder:text-faint focus:border-kin focus:outline-none"
        {...props}
      />
      {hint !== undefined && <span className="text-[13px] text-faint">{hint}</span>}
      {error !== undefined && (
        <span role="alert" className="text-[13px] text-shu">
          {error}
        </span>
      )}
    </label>
  );
}

export function Screen({ kicker, title, wide = false, children }: { kicker?: string; title: string; wide?: boolean; children: ReactNode }) {
  return (
    <main className={`mx-auto flex min-h-dvh w-full ${wide ? 'max-w-5xl' : 'max-w-md lg:max-w-2xl'} flex-col gap-6 bg-canvas px-4 pt-12 pb-10 text-ink lg:px-10`}>
      <header className="flex flex-col gap-1">
        {kicker !== undefined && <p className="text-[11px] font-medium tracking-[0.6px] text-shu uppercase">{kicker}</p>}
        <h1 className="font-display text-[40px] leading-[46px] font-extrabold">{title}</h1>
      </header>
      {children}
    </main>
  );
}

export function Wordmark() {
  return (
    <p className="flex items-baseline gap-2">
      <span className="font-display text-[40px] leading-[46px] font-extrabold">Kurō</span>
      <span className="font-bold text-shu">苦労</span>
    </p>
  );
}
