# IntelliSheet React frontend

React 18 + TypeScript + Vite frontend for IntelliSheet. It uses React Router,
TanStack Query, Zustand, Glide Data Grid, Recharts, Framer Motion, Tailwind CSS,
and Radix/shadcn UI primitives.

## Develop

```sh
cp .env.example .env
npm install
npm run dev      # http://localhost:5181
npm run build
npm run lint
```

`PUBLIC_API_URL` selects the Rust server API. Local, Server, and ICP storage
modes are available from the sidebar.
