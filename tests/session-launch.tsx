import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionModal, type NewSessionSpec } from '../src/components/modals/SessionModal';
import { useFleetStore } from '../src/store/fleetStore';
import { DEMO_FLEET } from '../src/lib/demo';
import '../src/styles.css';
import 'material-symbols/outlined.css';

useFleetStore.setState({ fleet: DEMO_FLEET });

function Fixture() {
  const [submitted, setSubmitted] = useState<NewSessionSpec | null>(null);
  return <main style={{ padding: 24 }}>
    <h1>YOLO 开关验证 · 仅捕获参数，不启动 Claude</h1>
    {submitted ? <>
      <pre aria-label="提交的会话参数" style={{ marginTop: 24, whiteSpace: 'pre-wrap' }}>{JSON.stringify(submitted, null, 2)}</pre>
      <button style={{ marginTop: 24 }} onClick={() => setSubmitted(null)}>再次新建</button>
    </> : <SessionModal mode="new" onCreate={async spec => setSubmitted(spec)} />}
  </main>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Fixture />);
import.meta.hot?.dispose(() => root.unmount());
