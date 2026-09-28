/*
 * Copyright 2026 Coralogix Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The default VitePress theme plus Coralogix design tokens. `custom.css` is
// imported last so its overrides land after the theme's own stylesheets, which
// matters for the same-specificity rules (e.g. the footer link underline).
//
// Choosing a tab in one code group switches every group with a tab of the same title,
// and is remembered across visits. The blocks are toggled directly, because VitePress's
// own click handler scrolls the clicked tab into view and simulated clicks would jump
// the page. The choice also lives on <html data-code-group>, which a <head> script in
// config.mts sets before first paint so code-group-sync.css can avoid a flash.
import { inBrowser, onContentUpdated } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { defineComponent, h } from 'vue'

import './custom.css'
import './code-group-sync.css'

const STORAGE_KEY = 'staghorn:code-group'

function select(title: string): void {
  document.documentElement.dataset['codeGroup'] = title
  document.querySelectorAll('.vp-code-group').forEach((group) => {
    const labels = Array.from(group.querySelectorAll('.tabs label'))
    const index = labels.findIndex((label) => label.getAttribute('data-title') === title)
    const blocks = group.querySelector('.blocks')?.children
    if (index < 0 || !blocks) {
      return
    }
    const radio = labels[index].previousElementSibling
    if (radio instanceof HTMLInputElement) {
      radio.checked = true
    }
    Array.from(blocks).forEach((block, i) => block.classList.toggle('active', i === index))
  })
}

if (inBrowser) {
  window.addEventListener('click', (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.matches('.vp-code-group input')) {
      return
    }
    const title = input.nextElementSibling?.getAttribute('data-title')
    if (title) {
      select(title)
      try {
        localStorage.setItem(STORAGE_KEY, title)
      } catch {
        // Blocked storage: the choice still applies on this page.
      }
    }
  })
}

export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    setup() {
      onContentUpdated(() => {
        try {
          const title = localStorage.getItem(STORAGE_KEY)
          if (title) {
            select(title)
          }
        } catch {
          // Blocked storage: nothing was remembered.
        }
      })
      return () => h(DefaultTheme.Layout)
    },
  }),
}
