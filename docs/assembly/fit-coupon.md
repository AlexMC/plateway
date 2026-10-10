# Connector calibration

A small sample tells you how the printed connector ends fit your real track on your printer. It is optional: you can print a layout without it.

1. **Generate the sample.** In **Print → Connector calibration**, choose **Generate calibration sample**. It uses the printer, material, process and nozzle shown under **Your printer**; change them in **Edit printer & process** first if needed.
2. **Print it.** Open the downloaded **3MF** in your slicer and turn on supports for the two connector ends: paint or enforce support only under the rail tongues that stick out past each end, and block it from the hollow rail channels and the clutch bays underneath. On a Bambu printer you can open the **Bambu project** instead — its supports are already painted only where needed. Check the slice, then print it yourself. Nothing is sent to the printer by this app.
3. **Test both ends.** Let it cool and remove the supports. Gently connect each end to your own brick track (or, for legacy custom-joiner projects, to the matching printed end). Don't force a tight connector.
4. **Report the result.** Tick **I printed and tested this myself**, then choose **Too tight**, **Fits** or **Too loose**. The result is saved to this project and to your local calibration library.
5. **Adjust and repeat if needed.** Pick a looser or tighter **Fit adjustment** (−0.15 to +0.15 mm), generate a new sample and test again.
6. **Reuse it.** In another project with the same printer settings, your saved results appear under **Your saved results**; choose **Use this adjustment** to apply one. Changing printer, material, process or nozzle turns the adjustment off until you apply or test one for the new settings.

A good fit on the sample is a good start, not a guarantee: still test-fit one joint of your printed track and run a wagon over every route before final assembly.
