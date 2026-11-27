export function SignIn() {
  return (
    <main className="signin">
      <div className="signin-card">
        <h1>Switchboard</h1>
        <p>The shared inbox for your support team.</p>
        <a className="btn primary" href="/auth/login">
          Sign in with Switchboard IdP
        </a>
      </div>
    </main>
  );
}
