export function SecretInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} type="password" autoComplete="off" spellCheck={false} />;
}
