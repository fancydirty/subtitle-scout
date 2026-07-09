import { render, screen } from '@testing-library/react'
import { App } from './App.js'
it('renders app shell', () => {
  render(<App />)
  expect(screen.getByText('subtitle-scout')).toBeInTheDocument()
})
