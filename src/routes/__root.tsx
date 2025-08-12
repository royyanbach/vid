import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

// import Header from '../components/Header'

export const Route = createRootRoute({
  component: () => {
    // const { pathname } = useLocation()
    // const showHeader = pathname !== '/'
    return (
      <>
        {/* {showHeader ? <Header /> : null} */}
        <Outlet />
        {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
      </>
    )
  },
})
