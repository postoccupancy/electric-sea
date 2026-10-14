'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const { ResidentStreamRegistry } = require('./ResidentStreamRegistry');

const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';
const PORT = Number(process.env.RESIDENT_PORT || 3001);
const ANALYSIS_INTERVAL_MS = Number(process.env.RESIDENT_ANALYSIS_INTERVAL_MS || 1000);

function midiStreamId(data) {
  const device = data.device || 'midi';
  if (data.msgType === 'cc') return `${device}/ch${data.channel}/cc${data.cc}`;
  if (data.msgType === 'pitchbend') return `${device}/ch${data.channel}/pb`;
  return null;
}

function ingestRouterMessage(registry, data, nowTimestampUs = Date.now() * 1000, onValue = null) {
  if (!data || typeof data !== 'object') return 0;
  if (data.type === 'sample_batch' && Array.isArray(data.streams)) {
    let count = 0;
    for (const stream of data.streams) {
      const streamId = stream.device || `osc/${stream.name}/${stream.param}`;
      const samples = stream.samples || [];
      count += registry.ingestBatch(streamId, samples);
      if (onValue && samples.length) {
        const latest = samples.reduce((candidate, sample) =>
          Number(sample[1]) >= Number(candidate[1]) ? sample : candidate);
        if (Number.isFinite(Number(latest[2]))) onValue(streamId, Number(latest[2]));
      }
    }
    return count;
  }
  if (data.type === 'signal_batch' && Array.isArray(data.signals)) {
    return data.signals.reduce((count, signal) =>
      count + ingestRouterMessage(registry, signal, nowTimestampUs, onValue), 0);
  }
  if ((data.type === 'osc' || data.type === 'json') && Number.isFinite(Number(data.value))) {
    const accepted = registry.ingest(
      data.device,
      Number.isFinite(Number(data.timeUs)) ? Number(data.timeUs) : nowTimestampUs,
      Number(data.value),
      data.sequence,
    );
    if (accepted && onValue) onValue(data.device, Number(data.value));
    return accepted ? 1 : 0;
  }
  if (data.type === 'midi') {
    const streamId = midiStreamId(data);
    if (!streamId || !Number.isFinite(Number(data.value))) return 0;
    const accepted = registry.ingest(streamId, nowTimestampUs, Number(data.value));
    if (accepted && onValue) onValue(streamId, Number(data.value));
    return accepted ? 1 : 0;
  }
  return 0;
}

const zlib = require('zlib');
const PAGE_GZIP_BASE64 = 'H4sIAJefZWoC/80823LbxpLv+Qqap2IAJgiRlGU7gECVrMgnPhtb2Ujx1imVKgUCQxIxCDAASEkhWXWe9gO29mV/YF/3cd/3U/Il2z03zACgpFy2asslE5jp6enp6enp7unB8bMoC8v7JenMy0Uy/uKY/hzPSRCNjxekDDrhPMgLUvrdVTntv+ny0jRYEL+7jsntMsvLbifM0pKkAHUbR+Xcj8g6DkmfvthxGpdxkPSLMEiIP+xCL2VcJmT8PSniCFp1PmUAXRwfsOLjoryHny9ebCbZXb+If4nTmTvJ8ojkfSjZTbLofrMI8lmcugNvGUQRAowGyztvEoSfZ3m2SiP3L4MA/3lhlmQ5vA2m0zdvvCnQ6Q5fLu86iyzNimUQkt18uMFi7Im4wyNAk5CyhM6wGlE7I7LwMnwp713n1dHOKcqgXBUbWXbkcXreAOZBZwg/O2cZpCSxHc4LJGu5YcNwhwBWZEkcdf4ynOA/0X6wpzVOCJCyEaMdjhBmEUdxnwPiDORZUtjOZJV87iuvJCjl6yaKi2US3LvThNx5+F//Ng+WLv7nzeBhiGwMkniW9uOSLAo3hAki+a5OyEN4ms29n1ZFGU/v+1xOXMr5/oSUt4SkrOMRzp+Y5bLMFk0uSSqooOg0tHQq0NaJ78xHlfw8MvXDlzD3Jbkr+2UepMU0yxfuarkkeRgURAjXdDqVfcSRIhZHKnpKiZiIzmQFY0yreesUJCFhqRTE6XIF79UkyzZKkWilTboE1Oa+gtVKeTdFmZNgUQemK8ON0znJ41JbXsPhUAw/CKbT6KXXlO3Rm6PBIZFL9FULAxycQahsGadD0mCSkGijdfvy8Gj0SmO8xJgEE1wJtZHUx0uhdNlBQXm9R+51Pl2jrvRBEmbkRi7GgUcVnTvExcNXJdMQthOsojiTb4tVSTT52OkTx8WyX2ZL9yvERWsZxXorHBIMNF5WKgE67zxlFelaMsJ/HOE6SFZkU/HWWwAtbGyH4XxX4nRs+FgHgy9FR9AgCZYFccWDRyGB7vtsVbrT+I5EO9gIymhDVxJls5uQaSlF4/UTyF6TvIxhD+HtgUe7EveCTpm7SVDAFM/jJOpALzqmAfStanjAXGnzl2LhbjLAP02yW3ceR7ArsUUvC0mSxMsiLrzbOcgH1Q/ETTPUdztnTfevfghAmzmJZ/PSfU2VOK8oQphcWfXqJRLAEffv3WBVZl6NviROUV1R+KEzOhKM6ue06KVELgV5kmTh59qK5NLE+YCisZd6J06DsIzXpJKzQ5Cz2wD2blD3WuEsySYwDUwJ6wquqT9HD+lPTiAbFHLsi+MDtvsfHzAbBCcYzZLh+Pvzy/dfn3+86rz7/vyffzj/ePb3zqeL92fnlwA6HB9H8boTghgUfpettm4njuTzGFZYCvoMaPr1H/95fADQgFVpwxRPpYPA0GFaiGKh5UwddTtUBXRZbXfMSjsf3n/9/viAFY6P6Yodg/CDyugcM1VaIWLl3Q5MHVVw4+NsWcbQFV1/frc7TrOUHB+wUmAFQwAPDC9HTxka04aNLqq6bh17QmZBmXW5gofeWUHVnQ6eE9AysxnJu2P5+ABpdaYBM+OwxrNq4LS2YhtITSomRNGi3QqdmE5kd2eVBusgTij/V2kZJx2+YwBZgGm8d5or7dnVBEfbKLo6ParQd8dBknSY3igoNtEj5wLdKyjVvBnFzKkT3AjnJPwMBm13XJA0qk1uONcmVUUDFnnKJHSPYJyd7W8btjWjtNP57mhjrjaFbgMTKx7/+o9/l9xmP9ok4n7XbBvC3lN2x4POmhv+ynSJSVsEMRMjajjjbBxgEdSANo2X5fgLmKii7CxIUQQzUvgpue18CJamZbMWSgGzCC5BNcH6L6BMqUOCLkGqVAwex82kzQcXabUAc8CZkfI8Ifj49v59ZBqs3hA9fp9l5X5gBmMActCRHWoXnKE1fFf66SpJ7CRegG7O2QsK+2kIvCmq9wuqNqr3cyZO/jRICmLjDvgWxnIVh5990K+oaYMUFDuoeWVE92k5Z+6WwgPEVi8ULXCl/fjN3y+vzlEBX/rOK/vb87+eXl38ePHp/PtvT7/78cOlf3hkvz0/vfrx7OzH9x8B8tPpt1gM+5aYJUnvfgYpStawlBFfUml9pB3TqbzdldR+j7Sq1CRv+R0qpEcaUaXF4S8fkRBFaRmSpWwp4GT5G64TXDaJfGmDK2KHoTu06SJzmXjA/F6i64RvuyYqIQ375a+piVByJYIz1vfTEHBCdQThE9uGWrNPdJ95UkvKDr1P1CRP7BZBcRKmqzSkO1y6WkxIbq7tyD+0NrC7rfK085EWOnHxDuMWxFxbJ2unzN6hEWtGlmuAxjN2FRK2C3wMFsRkauZ9ZG3Y5Cz9S9hj0pms2G4Nw3LAXotL0ziAx2mcwJI332ZZQoLU8jgNS6hII/POH9/5vm/Ac5aBTfX53thuaQldEXkc0jJru11eD2/w/wH8b2QleGsqiaz7b1HX/4k0Xi+dhKSzct7HvkVzpVuq3P+J3EvUdhxJNouynuG6Ri9W2+Ga+ZiVjKcpPAhaU//aODNs4+zX//gv+Pka/9jjOfy9wz/2+lf8Y4+n+Mce3xo3du5/CMq5Q50fhluMJ702zfzL4cjqwR/83vRMCgpGepab+QGU9oeWQiZfAhfUEipMYU5ZG1Tvc98wwKbPTXyJ/YEXHw9feXGvZ817vlEzsWD8PQP+N2OYW4HnxJAWmuHClPSMMUL0hvAk7S9DUD9XCQufTtPozR8nKn6MoGmcF+UP6aogEVcypphSLKN7DmzO5rXjOI2t2qH0FKZ14yxgXyr8ceHgxHFMltXO5nhqPkPkzjwozNiyOFmxoG/QWB+iTzPm/Cr8JjGgYLDeQ/SFGEQ499uG6BX+Binlmtkt8xWxFdLdcE6tj3NtC5hUqlgAnIXuaNAzm9Sg2/XlmwEzYj7pewVqR2W/aGlMh2IX1k4sydoa/ETApQSnzwzlqqUrYhHcmaOBzZ7j1ByOXtvKqgJSJZgKZTPNCti224FlvRgOXluWuqBIWqxycoqGEcgHcFi1kfgEerrdBIJj3qJ6vHVOlYrtlhfeksnnuFSrLJgXYWmpuJwQ+FOSr+/TYBGHxVm2WOZgfYFoSXinnEPRPEsiJpN+/42s+pwSwkuHI1maBzAwXlzBBmUZhJ95sTMYHFbwsLbALRZVYD6JGu6+aixxIlLAbGIfqcpHWCZLEn3AGWRLZ/6LPROymmTQ5ZE9j/2hHfpyopKsmql5bM9/sSx7mRUMIMlmIzM8SDLroHqfx1hgJ9mtb/KZnTkToP4iLIM1HwMoU5jokY0+VZyuslWBZPnQqAfYX1QN0QHgTQBeKOWN3s7+eRXA+y9scK4iczqctWtwg4rAu5z8vCJpeK9xZOG3M8wGk9KfOcu4DOcfskjMCuy+uDiMk4Wjk7NwdCqEpnn5cvCCkroEQ3xkm4C2/+orCzcUhUwWfGFG+Lss/5paFSYeswg6c//6huo69noNa3dx08mm0gOia0YxR0BPPfN9ioJTRpT2a9qUR6i22+sbVJlrh9Fh5c5yVczNjdimXegNtPN6J7VFvp/4S9qI6lHJYk6jVKAci7l4/lwjQpgba38siaGKHwrayNF4mCSnCiXmHs7NcOTMG5ObixgwIG2fiZlDGSkJV4fPVMeldK3Mz+TentlT0X/WpmkuijBOkqBEDWPPwLNtA/orlIMCyhwaMTCKOCUGvE2FIHOZnHqIwKH/sZIBQAmdgcVW9eZMVgWiBK8kLwE5dwz9TSYpcjNKEXNrUZZcNnzYRir/kW4gONJCMkXdQQAyVHT5s0DTz8+4YhNqnRt4oEx0LqzyHPawq3hBbDYv0liwHptR2isb7Yb+PMBgWq/zjxUJrglyd3zxMGf5QVGBrT5f+AySW8onwwOpCbQK2zk8stxhfXkyGCFGwGtf2tRrR1rVawcXFKPFCaIIJ0VM69Rv1X/rSoS+QV3ncXtHmd0Zm11h6hT+Xin3CNgtm8Kp5EcR0BBjEMllOCfRCowcrmBhosE8am8BYnUV5ND9KZ13cwqMvLWd4RvJ/Fm1bzkDcJXlzuWMRgj4Yo3zNsWz5RCW7AucCI9PL/3vQaIqsDolM3EidbKeuQNGFszbTpGeBzArUPsRyw1xnSXg0vItUXSGO+OMHSmxwIODonzGz94rLLpw9QyuoJk8gUmvVcOONjwxwJwvDAvcW4odhG9q7JTNhq5zutsoMsKMNCZ3aGajuFRbzZ/AcD7sVwBFaAnsnaZp+WOmUfSenz9vE190XqxNmd/rAlqU2dIEgQpgc9/stKooLsSql9TpZUo3EVhsJV0KYHTYo6PBQDM+MLCLruxFaoItn9pryrIqtGVVjw7CmteDu68GWwZ7Y7Vhmk4ZKug5uPcHTM0pGDWFuihmPqB8w1EObjza7KTeLcDZjZhhj8JabgtwnbKzEIkKwycN8C2lBoG1EdKwGhpOZh3HphLEglotMlxZaXuVP6C2mQNlM1exchHBUxt44RydxHAOXuJe6oajQ+CWtVO6CsE2R29gtYxAD36QwT9THcT8voBtgpRxiMSYdzbfwdg01WNLotJS3Stm0d5RxXs35iC9Whh2u7075lX9WlU7Ml7I2ygUVyFQSjF4N3ZNVKtoamUCszMj4/lz9IY4t6E8nFubpsx76uQoDWx8xglqRpStHdtUHmmooJa97WpGCBUpEICQsEh5tWK44w3WyL7181ttjtr+/bApuRGWVy3+UG3tfPN1lChCpV+fYBTYLb5NfetHXvqKmAvFSSMVPuVbw9WpSXnd80GUTDLoHNlrkA0toKDtzw3LBccMjTVJ0mI+lDTEankK4cIc3YggensbSoELDzsmY52YiRbWo7sEP9utImtQpgecNi0r5v+GvPYNuMJpteyC1uZhTahQpO5dDyo1eURGYXlsrDo3q5uKG/AllkAPKVzlCG6RYVw6AlMGo1O4mbuNHWfnKVgr96ItQCUjXrCuKBizadBgkAsL8fg68XZU+pW5OLSVSBWaI/SohjiCQnDSB7Cjg5bRikFIbvnyWwZxXij6gfJmtfAH9u0l/tSCk5rhReOUov4nP+4NvZ9qED8BBB9NwF2J6/jGnojnn25spMC/liogqFRAQFWArJlUNROsuXGKDB1A56cMeGFs8Vzl1OcaDadUCSVUWC2AersHaqJAUVmYnYJunb2t66zpabtXEuiq6dSyp2/bISc65FuY1ymb12BSmNPT/hSKbjU3wRbBpkBVPhiKlGGoSb2GzSeVZZ+JAJNrOnBkPEJ5rN6kP70Ri/V89/5FNH0RldaXpiwRYsRxFByHTd8tj4oS1YIUswdi1PNvWeMwK0wOhnIF5YpuQHBqmavYQdhxQ8JZYIhRQVDElgbHlQDrkodLglsfezkBCg7wwR1wysUi7vngirwwAbCvV0g7ozUCrMeJzRrOofXi1aFzpMeEF8H9hFyCRsNwtkmnZ8ZORdk2zkqE48N38of2dWjE26hBcjBdGFIOJWxaBsl16MkJf1dC9LYACfXakBPptXVGq2q6DI/tqUOEw0JNpJ7nj/2W03VQxOqRP+okPTrI/bV64F8olPYYRhW7YyPwNUVrMGz0xE7VuOAnSTg2PE+fuULhB4pYdrtHh0DH1glIyG2hnrXAuwV/YIaQ/J7lAyA1ItVTPRzWXGLG6ccCRb8hptPGE0Y98IQBaXyZ8exCZAK3ntvYo4IJTqlltLPmyDQYehSuw9SiAI+6/zzAEiSJ34iltg6dna8bNkDz8cqT+YdGK4HkWPVsgLaR6kf+GgT03hxkVaiNkG4bRXmaxgt6cPIupzsXX0W6X1uyyUdjqjBndpaqnmgcUVliosq1bfMgUTXd/Sz1pEOCmjKNSH6aJGZrr8At2J9xwL+7b+VwEftu75DHQXFNaMcNBQn1BBoGyNMrQBOwegNdMPrk0JwvXMS+od55MCRADBoz/+bqw7e+oWbd6cn5LCNv3ALAU++O5yPMDh3pmWYy+7471tPJ1PQ+NdW6lt5XJVpj9mVZJaXxhEYORqv62XRaTwPFhEAornIZW9ulrc3S9gxIlaSCSgPdKTpnZ+20YeXvoY23e5Q2JT1P5arCUB0vS30vs9msmTVLDx9YElw9a5YeuHUWWURkFqNI3sSaPtY0klorB1RJbK0K9yW3on3Ak0n5pD+Sc4sHnJ2MnnDWqcOqPquS5I2H9Z7HowYtkt7DBvDLRsnRoyQy/lFB4nmoIi0aisQ80BsMXfAlU787hN/gzu++AtaVZEkLOH8Oa6sEn0Xm5yGXQmRHjQQWvK51zwrbCBhwAkbOkSABDHZJhPOmRgXDJOgYOG8GcskrCa26GIrEYRnebkk6baQC/6EUYaaR9mcH64rrjyQIt2D6LTnCbc1/Z5pwR0Xy9AxhrdnjycHH9HoJ/LArAmWOjx16b4BfQHSHR192x5fnHy8vvj8+KOdNgK+g/uPFFd4eaKt+DdVn3+xvivY4VcS/tTGtO9uP+PLq9OqHh4i6+CQqx+L6A74eIBcOBEforQl4Fb+UX4ZIGv3Zv/PHYlPWTeo7y+b7sP+zacxHBnjWdG7eR1hQXXKDCqa2abGq6qFG5kzQykptYyOZIULrFKUJlTjTtBgf+DvzKUShTAFlOoCWs0dZVjVQ9QRUK+dmCtEyhxt5heWUaXLcamqtwoBaFq1ihfNYeB22SphVYMMmWKhBVGNpLCwdE02DbSDjGa98RjWbGU09T0ytViP8mY7Ro0BMZqq+9uUs0yvBerbqyfClOzzEVObWyoE7bKQ419LWGoxVjMhaAqbiaPEaS20eqi3Dtkah8E5n/oY6cnyJUMmw0dZW4pk6Dyargg2BX7yUC0CRdyrNlUhzaVWFVpVQZXLr8lCf953HPVqMKFHCZ5ZX3UhwMICWRmd4Oc7kQ7I8fsUyiKLzNbD72xj2XWCPaYQJ+EHg0aGnQo9atbQ8r5aW57AgK8xssSqwG1wOAd4a0244ODkpYJQmDwv+2UkZMgDkP5OPYoTtJ+QGHgAzEtExrKxRQ7Sj+xOyxWFqzTT4TVXDlmjoWbDIctlZXpUr1sLXOVo8hk15qrhiKgrFPQRsSjLdH0WHqaeIkqbZNZFRg4TjkgKqca7Kz/Oe3BlPYXi4O0X8tQ55SFZLg5Bp+KM641HzSdfMsJwspWLsYxcNP56dAqpt0sea0CHRFtLJ2tdE99uVvoSb9bSGrMfGHoRN6czTtor2Egug2YJakbAemqp0Hy5xnsvnoNmQR2007boXWdiCJxQoeLh4pgQkmHyxFKP1g2majaNMpoxqh5l7T0ctO8HDXdroxOj8z393Ln646oBdbfR4bJozgubcQykrRJlxDZnobtRcE7T5McbG8whp4EncrcWE+e74L0YP+6coxRUUbSQvsbtvfkGKFIglyeMsuiTAjqiwRwhTIAj1XiVc4yyWAv76r/8GILVjXCg3oVC9bVGDgKaW0UMu9Sh/MJitklQdl9BuuKluNCbT5Omf1kbmgeJexV+4zWILIJEMiCaDEhnWoS17pkaQaeRqu20Es+zG6XoNDT3hoeHoKuhcB8E9CyPQG4TbFw8rc7C0MEatRrnKSPeu0Ksq0UCPuB9WXVnWvlnQrTmJKHNP9A4lft27oxjavMLfQ85vcFb3kLPXSX0IXHNKFZ+c3TJt80wb5wO6O8pcStFl/UFb0+x2vx4L0G73d1V8BloqYDVqtlfODgSomLWIP63mok/8ttMOVQrA/E/D/VCVuzFpx1VzYCbhfqgKV/gQFHguXhrut8/1LApv8iCocsQGTGm33TkUmO0p0befjZYy46dEboJ74u9IeBuGM30nTOW+pRs7Oq5JjZpCC8RPKmImYRtgrc+J7DNsB5f7aygg+TEOmyz6UQygzwuvBze6TadcC6yrPAaMgSxfr/IeF0wxPl+bBe9xKVQaKhwDWl7phAuKgPzo/sSgP4ZrKsVFlm63Bv94hWExFNX5RA0B7NACFCBf652JfZU3CfHDHfAAG55XnZbhzTUJotxm4DkWZmBPYMIwIaNPcy9EMjseUrVceLCLeXab8qNIkTvO3lxsUiRoHA3sQ6uVq5peArZWi4fiFQjZC79boVpdG7xaYcu7FroA7MDQEjkjhuXq5g9no/iABTMH9nk4dSuBLh/llGuhXm5Rbmpwk0JF0Ehfole98CidPVRXtbW5xWdux+32gCj5BM+fV+kEJ6ZB7S7om1ppaqIXWE9VyjWuADAHa/V6zrVZ3fY/4WjBv3CNhz9yYWjJs9lylXAWMAqr6y/LnKz9inR1GCCLXv2ivWbAPPhhEsMTmZSMeJE9UU1hJhLWGIDDbuk3z96z5V67ivUFazjjV0H9DKmGN3WaMnr0vt1mIM/pagrMX+Ukx/e2Eaq7cra0djAMZBLjTI1UmjcDlZbVQMPIwUp2BUKye0ryHNQYaoUHBn/Dbnln/vggF1/Ck27ANg7CgxjGWJSmGBysN2qMyh4eIIkBwOh3yqcjWoih9m4rFjCnMaTV5J74egtLp/XkZxOqCiXvpjVdmgaXOsrFT2xWpX4/A5GPZzQZnx/X40rgMrZpIDT+hUyYFxQXuN46xWqJXyUkUSdOO+UcSidodBFqobPVjhcClG9ssIjVA92aLHNSMC+lriDfi1vWnte6Hj31qx38Pr2a567U79NBJwZnMh0w6Ajl80OG2r4ZvhJqQ/12CBUn9V1Rz+xuRJPblNPgjC7iomAfQEhjqo12Xyj9ixBHFUes6YoN47k692JyajQpFwM0Dj7TdPP/d35SFdFpWQ3NBaZbovXhN9Zyq9p62rp+YN3WrpU0PjjzwEj3DVK5SLB/iPsFUqFYSJds6PEL381g44TAdkRWaZIFMFeygeV90fj0yX6HRElrkmcL6odPWv0TtVGowrfG8hRoEctrthCeQ5P0fbhqsbxmw0YGVj2Wpw2jBY/0T/jp4i3LhwalfJkBsbCF3xbuwYHRS7KQplw586yAxXmLejSDjZg5M03Ty8DAEzOvtKasZZhkhfDVWtpWN7ZgiXqKgO1Yc25X+gTa8xMu/2+XFx+dJX7u1gRrNygDKo0Ru3zr+4bYpX9kBrYhTNEIkD6SV+bhh+3Yd6uOD/ipLP3U7v8CC7bu5IFXAAA=';
function page() { return zlib.gunzipSync(Buffer.from(PAGE_GZIP_BASE64, 'base64')).toString('utf8'); }

function startResidentLive({ routerUrl = ROUTER_URL, port = PORT, analysisIntervalMs = ANALYSIS_INTERVAL_MS, registry = new ResidentStreamRegistry() } = {}) {
  const latest = new Map();
  const liveValues = new Map();
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/resident/') { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  });
  const wss = new WebSocketServer({ server });
  let routerSocket;
  let reconnectTimer;
  let closed = false;
  const publish = message => {
    latest.set(message.device, message);
    const json = JSON.stringify(message);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(json);
  };
  const unavailable = reason => {
    for (const device of registry.streams.keys()) registry.remove(device, reason);
    for (const message of registry.drainPending()) publish(message);
  };
  const connect = () => {
    if (closed || routerSocket) return;
    routerSocket = new WebSocket(routerUrl, { rejectUnauthorized: false });
    routerSocket.on('message', raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'streams_unavailable' && Array.isArray(data.devices)) {
          for (const device of data.devices) registry.remove(device);
          for (const message of registry.drainPending()) publish(message);
          return;
        }
        ingestRouterMessage(registry, data, Date.now() * 1000,
          (device, value) => liveValues.set(device, value));
        for (const message of registry.drainPending()) publish(message);
      } catch {}
    });
    routerSocket.on('close', () => {
      routerSocket = null;
      unavailable('router-disconnected');
      if (!closed) reconnectTimer = setTimeout(connect, 2000);
    });
    routerSocket.on('error', () => {});
  };
  wss.on('connection', client => {
    for (const message of latest.values()) client.send(JSON.stringify(message));
    connect();
  });
  connect();
  const analysisTimer = setInterval(() => {
    registry.expire(Date.now() * 1000);
    for (const message of registry.drainPending()) publish(message);
    const message = registry.analyzeNext();
    if (!message) return;
    publish(message);
  }, analysisIntervalMs);
  const valueTimer = setInterval(() => {
    if (wss.clients.size === 0 || liveValues.size === 0) return;
    const updates = [...liveValues].map(([device, value]) => ({ device, value }));
    liveValues.clear();
    const json = JSON.stringify({ type: 'resident_values', updates });
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(json);
  }, 250);
  server.listen(port, '127.0.0.1',
    () => console.log(`Resident voices: http://127.0.0.1:${port}/resident/`));
  return { server, registry, latest, close() { closed = true; clearInterval(analysisTimer); clearInterval(valueTimer); clearTimeout(reconnectTimer); routerSocket?.close(); wss.close(); server.close(); } };
}

if (require.main === module) startResidentLive();
module.exports = { ingestRouterMessage, midiStreamId, startResidentLive };
